import re
import subprocess
import time
from pathlib import Path

from cvsmart.shared.paths_service import TEMPLATES_ROOT, NODE_TOOLS_ROOT
from cvsmart.rendering.services.tailwind_service import compile_tailwind, TAILWIND_DIR

IMAGE_IMPORT_RE = re.compile(r"@/images/cv-templates/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+\.(?:png|jpe?g))")
COMPONENT_NAME_RE = re.compile(r"export\s+default\s+(?:function\s+)?(\w+)")


def collect_download_assets(jsx_path: Path) -> dict:
    """Rassemble tout ce qu'il faut pour utiliser le composant genere
    ailleurs : le .jsx final et les vraies images qu'il reference (deja
    placees par le pipeline dans templates copy/images/cv-templates/<slug>/)."""
    jsx_code = Path(jsx_path).read_text(encoding="utf-8")
    match = COMPONENT_NAME_RE.search(jsx_code)
    component_name = match.group(1) if match else "TemplateHtml"
    images = []
    for slug, filename in IMAGE_IMPORT_RE.findall(jsx_code):
        abs_path = TEMPLATES_ROOT / "images" / "cv-templates" / slug / filename
        if abs_path.exists():
            images.append({"abs": abs_path, "zip_path": f"images/cv-templates/{slug}/{filename}"})
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
