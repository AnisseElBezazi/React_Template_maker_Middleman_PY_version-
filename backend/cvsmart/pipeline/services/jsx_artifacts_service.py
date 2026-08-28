import json
import re
import shutil
import subprocess
from pathlib import Path

from cvsmart.shared.paths_service import TEMPLATES_ROOT, NODE_TOOLS_ROOT

IMAGE_IMPORT_RE = re.compile(r"@/images/cv-templates/([a-zA-Z0-9_-]+)/extracted-(\d+)\.(png|jpe?g)")
EXTRA_IMAGES_RE = re.compile(r"EXTRA_IMAGES:\s*(\[[\s\S]*?\])")
ASSETS_RE = re.compile(r"ASSETS:\s*(\{[\s\S]*?\})")


def place_extracted_images(jsx_code: str, out_dir: Path) -> None:
    """Copie les vraies images extraites du PDF vers l'emplacement exact que
    le JSX genere reference (@/images/cv-templates/<slug>/extracted-N.ext) --
    le nom du template (<slug>) n'est decide par le modele qu'a la
    generation, donc on ne peut placer les fichiers qu'apres coup."""
    for slug, index, ext in IMAGE_IMPORT_RE.findall(jsx_code):
        src = out_dir / f"extracted-{index}.png"
        if not src.exists():
            continue
        dest = TEMPLATES_ROOT / "images" / "cv-templates" / slug / f"extracted-{index}.{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def crop_extra_images(raw_response_text: str, target_paths: list[Path], out_dir: Path, python_bin: str) -> None:
    """Un element graphique du PDF sans equivalent bitmap (logo/ruban/forme
    dessines en vectoriel) : le modele donne sa zone en pixels, on la
    decoupe depuis le CALQUE DECOR (fond sans texte) plutot que la capture
    cible, pour ne jamais figer du Jinja brut dans une decoupe."""
    match = EXTRA_IMAGES_RE.search(raw_response_text)
    if not match:
        return
    try:
        entries = json.loads(match.group(1))
    except json.JSONDecodeError:
        return

    crop_script = NODE_TOOLS_ROOT / "src" / "extraction" / "crop_image.py"
    for entry in entries:
        index, x, y, w, h = entry.get("index"), entry.get("x"), entry.get("y"), entry.get("width"), entry.get("height")
        if index is None or x is None or y is None or not w or not h:
            continue
        # Quand on reproduit un template entier, une decoupe est relative a
        # UNE page precise : ses coordonnees n'ont de sens que dans le
        # repere de cette page-la. `page` vaut 1 par defaut.
        page_num = entry.get("page") if isinstance(entry.get("page"), int) and entry.get("page") >= 1 else 1
        target_path = target_paths[page_num - 1] if page_num - 1 < len(target_paths) else target_paths[0]
        bg_path = out_dir / f"background-layer-{page_num}.png"
        source_path = bg_path if bg_path.exists() else target_path
        out_path = out_dir / f"extracted-{index}.png"
        subprocess.run(
            [python_bin, str(crop_script), str(source_path), str(x), str(y), str(w), str(h), str(out_path), str(target_path)],
            capture_output=True, text=True,
        )


def save_assets_map(raw_response_text: str, out_dir: Path) -> dict | None:
    """Correspondance declaree par le modele entre ses cles d'assets et les
    images extraites (ASSETS:{"page_bg": 1, ...})."""
    match = ASSETS_RE.search(raw_response_text)
    if not match:
        return None
    try:
        mapping = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    (out_dir / "assets-map.json").write_text(json.dumps(mapping, indent=2), encoding="utf-8")
    return mapping
