import re
from pathlib import Path

from PIL import Image

# Le rendu pose ses pages dans un conteneur `flex flex-col gap-6`, soit 24 px
# de blanc entre deux pages (verifie au pixel sur un rendu reel). L'empilement
# des cibles reproduit exactement le meme ecart pour que les deux cadres
# restent a la meme echelle et se comparent directement a l'oeil.
PAGE_GAP = 24

TARGET_RE = re.compile(r"^target-(\d+)\.png$")


def target_pages(out_dir: Path) -> list[Path]:
    if not out_dir.exists():
        return []
    found = []
    for entry in out_dir.iterdir():
        match = TARGET_RE.match(entry.name)
        if match:
            found.append((int(match.group(1)), entry))
    return [path for _, path in sorted(found)]


def stacked_target(out_dir: Path) -> Path | None:
    """Chemin de la capture cible a afficher : l'empilement quand le run couvre
    plusieurs pages, la page unique sinon. Construit une seule fois."""
    pages = target_pages(out_dir)
    if not pages:
        return None
    if len(pages) == 1:
        return pages[0]

    out_path = out_dir / "target-stacked.png"
    if out_path.exists():
        return out_path

    images = [Image.open(p).convert("RGB") for p in pages]
    width = max(im.width for im in images)
    height = sum(im.height for im in images) + PAGE_GAP * (len(images) - 1)

    canvas = Image.new("RGB", (width, height), "white")
    y = 0
    for im in images:
        canvas.paste(im, (0, y))
        y += im.height + PAGE_GAP
    canvas.save(out_path)
    return out_path


def png_size(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as im:
            return im.size
    except (OSError, ValueError):
        return None
