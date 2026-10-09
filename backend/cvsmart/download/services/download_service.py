import json
import re
import subprocess
import time
from pathlib import Path

from cvsmart.shared.paths_service import TEMPLATES_ROOT, NODE_TOOLS_ROOT
from cvsmart.rendering.services.tailwind_service import compile_tailwind, TAILWIND_DIR

COMPONENT_NAME_RE = re.compile(r"export\s+default\s+(?:function\s+)?(\w+)")


def collect_download_assets(jsx_path: Path) -> dict:
    """Rassemble tout ce qu'il faut pour utiliser le composant genere
    ailleurs : le .jsx final et les vraies images qu'il reference.

    Les images arrivent par la prop `assets` (pass1.md, regle "JAMAIS PAR UN
    IMPORT") -- le JSX ne contient donc plus d'`import '@/images/...'` a
    parser depuis longtemps (verifie : aucune run de cette session n'en
    genere). La correspondance cle -> image reelle vient de `assets-map.json`
    (ecrit par le pipeline a cote du JSX, deja utilise par la preview locale
    -- voir render_service.build_assets), pas d'un scan du code source."""
    jsx_code = Path(jsx_path).read_text(encoding="utf-8")
    match = COMPONENT_NAME_RE.search(jsx_code)
    component_name = match.group(1) if match else "TemplateHtml"

    images = []
    map_file = Path(jsx_path).parent / "assets-map.json"
    if map_file.exists():
        try:
            mapping = json.loads(map_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            mapping = {}
        for key, index in mapping.items():
            abs_path = Path(jsx_path).parent / f"extracted-{index}.png"
            if abs_path.exists():
                images.append({"key": key, "abs": abs_path, "zip_path": f"assets/{key}.png"})

    return {"jsx_code": jsx_code, "component_name": component_name, "images": images}


def compile_template_css(db: dict) -> dict:
    """CSS compile AU MOMENT DU TELECHARGEMENT, pas a la generation : le
    template peut avoir ete retouche dans l'editeur visuel entre les deux.

    L'app ne compile plus rien pour ces templates -- le mecanisme qui
    scannait les templates en base pour alimenter le bundle Tailwind global a
    ete supprime. Chaque template doit donc arriver avec son CSS complet.

    Perimetre du scan : le composant et le MOTEUR seul. Scanner tout
    "templates copy" embarquerait les classes de l'exemple Visian, qui
    gonfleraient un css_source destine a etre injecte tel quel."""
    if db.get("error"):
        return {"css": None, "error": None}

    from cvsmart.shared.paths_service import OUT_ROOT
    scan_path = OUT_ROOT / f".css-scan-{int(time.time() * 1000)}.jsx"
    try:
        OUT_ROOT.mkdir(parents=True, exist_ok=True)
        scan_path.write_text(db["code"], encoding="utf-8")
        css, error = compile_tailwind(
            content_globs=f"{scan_path},{TEMPLATES_ROOT}/engine/**/*.{{jsx,js}}",
            input_css=TAILWIND_DIR / "tailwind_db_input.css",
            config_path=TAILWIND_DIR / "tailwind.db.config.cjs",
        )
        return {"css": css, "error": error}
    finally:
        scan_path.unlink(missing_ok=True)
