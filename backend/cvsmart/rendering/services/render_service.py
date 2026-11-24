import base64
import json
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from cvsmart.shared.paths_service import NODE_TOOLS_ROOT, TEMPLATES_ROOT
from cvsmart.rendering.services.tailwind_service import compile_tailwind, TAILWIND_DIR

ESBUILD_SCRIPT = NODE_TOOLS_ROOT / "src" / "rendering" / "esbuild_bundle.mjs"

# Version du schema d'etiquetage (data-cvimg / data-cvtext / data-cvcls).
# L'editeur s'en sert pour savoir qu'un rendu ancien doit etre refait : sans ce
# marqueur, un HTML produit avant l'ajout d'un type de repere laisserait
# l'edition correspondante silencieusement indisponible.
CV_TAGS_VERSION = "4"


def build_assets(jsx_path: Path) -> dict[str, str]:
    """Prop `assets` de l'apercu : les images extraites du PDF, converties en
    data URL et indexees par les cles declarees dans assets-map.json. Sans ca,
    un composant qui lit `assets.page_bg` s'afficherait sans aucune image."""
    map_file = jsx_path.parent / "assets-map.json"
    if not map_file.exists():
        return {}
    try:
        mapping = json.loads(map_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out = {}
    for key, index in mapping.items():
        image = jsx_path.parent / f"extracted-{index}.png"
        if not image.exists():
            continue
        out[key] = "data:image/png;base64," + base64.b64encode(image.read_bytes()).decode()
    return out


def bundle_jsx(jsx_path: Path, data_path: Path, width: int, height: int,
               bg_fallback: Path | None = None) -> str:
    """Compile le JSX en bundle navigateur. esbuild reste un outil externe,
    appele en sous-processus comme pdftoppm ou tailwindcss."""
    assets = build_assets(jsx_path)
    with tempfile.TemporaryDirectory() as tmp:
        config_file = Path(tmp) / "config.json"
        out_bundle = Path(tmp) / "bundle.js"
        config_file.write_text(json.dumps({
            "jsxFile": str(jsx_path),
            "dataFile": str(data_path),
            "assets": assets,
            "width": width,
            "height": height,
            "bgFallbackFile": str(bg_fallback) if bg_fallback else None,
        }), encoding="utf-8")
        result = subprocess.run(
            ["node", str(ESBUILD_SCRIPT), str(config_file), str(out_bundle)],
            capture_output=True, text=True, cwd=str(NODE_TOOLS_ROOT),
        )
        if result.returncode != 0:
            raise RuntimeError(f"Bundle esbuild échoué: {result.stderr or result.stdout}")
        return out_bundle.read_text(encoding="utf-8")


def build_html(jsx_path: Path, bundle: str) -> tuple[str, str | None]:
    """Assemble la page autonome : CSS et JS inline, aucune requete externe."""
    shared_css_path = TEMPLATES_ROOT / "visianSmartCv.css"
    shared_css = shared_css_path.read_text(encoding="utf-8") if shared_css_path.exists() else ""

    # On ne scanne QUE le composant rendu et le moteur partage. Tailwind ne
    # genere que les classes qu'il VOIT : un composant hors de out/ se
    # retrouvait rendu sans ses classes utilitaires, les images reprenant leur
    # taille naturelle -- ce qui ressemble a un bug de mise en page. Scanner
    # tout out/ faisait a l'inverse relire les JSX de chaque run precedent.
    tailwind_css, tailwind_error = compile_tailwind(
        content_globs=f"{jsx_path},{TEMPLATES_ROOT}/**/*.{{jsx,js}}",
        input_css=TAILWIND_DIR / "tailwind_input.css",
    )
    html = (
        '<!doctype html><html><head><meta charset="utf-8">'
        f'<meta name="cv-tags" content="{CV_TAGS_VERSION}">'
        # Le garde-fou `max-w-xl` de la racine (voir ensure_root_max_width) est
        # fait pour Middleman : ici il rendrait le composant a 576px au centre
        # d'un canvas de 1240px, et l'apercu comme les mesures de taille
        # (dictionnaire vs rendu) seraient faux. Le JSX exporte le garde.
        f'<style>html,body{{margin:0;padding:0;}}#root>*{{max-width:none;}}{tailwind_css}\n{shared_css}</style>'
        f'</head><body><div id="root"></div><script>{bundle}</script></body></html>'
    )
    return html, tailwind_error


# Les vraies pages sont les enfants directs du conteneur qui occupent toute sa
# largeur : le moteur de pagination monte aussi un noeud de mesure cache
# (aria-hidden), habituellement plus etroit -- mais un template qui passe
# contentSidePaddingRatio=0 lui donne exactement la largeur du conteneur, ce
# qui le faisait passer pour une page (capture hors-ecran incoherente).
MARK_PAGES_JS = """() => {
  const comp = document.querySelector("#root")?.firstElementChild;
  if (!comp) return 0;
  const full = comp.getBoundingClientRect().width;
  let n = 0;
  for (const child of comp.children) {
    if (child.getAttribute("aria-hidden") === "true") continue;
    if (Math.abs(child.getBoundingClientRect().width - full) > 2) continue;
    child.setAttribute("data-cv-page", String(++n));
  }
  return n;
}"""


# Texte qui sort du bas de sa page (contenu de longueur variable pose dans un
# bloc a hauteur fixe, typiquement une couverture) : il deborde sous le cadre,
# ou est coupe par un overflow-hidden, au lieu de passer sur la page suivante.
# On mesure les NOEUDS TEXTE (pas les boites) : une decoration qui depasse
# volontairement du cadre ne doit pas compter.
OVERFLOW_JS = """() => {
  const out = [];
  for (const page of document.querySelectorAll('[data-cv-page]')) {
    const bottom = page.getBoundingClientRect().bottom;
    let worst = 0, sample = '';
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.height > 0 && r.bottom - bottom > worst) { worst = r.bottom - bottom; sample = node.textContent.trim().slice(0, 60); }
    }
    if (worst > 4) out.push({ page: Number(page.getAttribute('data-cv-page')), over: Math.round(worst), sample });
  }
  return out;
}"""


def render(jsx_path: Path, data_path: Path, out_png: Path, width: int = 1240,
           height: int = 1754, bg_fallback: Path | None = None) -> dict:
    """Compile, monte et capture. Renvoie les chemins produits, le nombre de
    pages et les erreurs JS eventuelles du composant."""
    jsx_path, data_path, out_png = Path(jsx_path).resolve(), Path(data_path).resolve(), Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    bundle = bundle_jsx(jsx_path, data_path, width, height, bg_fallback)
    html, tailwind_error = build_html(jsx_path, bundle)

    out_html = out_png.with_suffix(".html")
    out_html.write_text(html, encoding="utf-8")

    errors: list[str] = []
    page_paths: list[Path] = []
    overflow: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.set_content(html, wait_until="networkidle")
            page.wait_for_timeout(150)

            page.locator("#root").screenshot(path=str(out_png))

            page_count = page.evaluate(MARK_PAGES_JS)
            overflow = page.evaluate(OVERFLOW_JS)
            for i in range(1, page_count + 1):
                element = page.locator(f'[data-cv-page="{i}"]')
                if element.count() == 0:
                    continue
                page_png = out_png.with_name(f"{out_png.stem}-page-{i}.png")
                element.screenshot(path=str(page_png))
                page_paths.append(page_png)
        finally:
            browser.close()

    return {
        "png": out_png,
        "html": out_html,
        "page_count": len(page_paths),
        "page_paths": page_paths,
        "errors": errors,
        "overflow": overflow,
        "tailwind_error": tailwind_error,
    }
