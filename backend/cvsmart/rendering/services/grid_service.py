from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GRID_COLOR = (255, 0, 255, 115)
LABEL_COLOR = (209, 0, 209)
LABEL_BG = (255, 255, 255, 191)


def add_grid_overlay(image_path: Path, out_path: Path, width: int, height: int, spacing: int = 50) -> None:
    """Superpose une grille de reperes (coordonnees X/Y tous les N pixels)
    sur une image -- pour que le modele puisse RAISONNER en coordonnees
    plutot qu'estimer a l'oeil."""
    base = Image.open(image_path).convert("RGBA").resize((width, height))
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 9)
    except OSError:
        font = ImageFont.load_default()

    for x in range(0, width + 1, spacing):
        draw.line([(x, 0), (x, height)], fill=GRID_COLOR, width=1)
        label = str(x)
        bbox = draw.textbbox((0, 0), label, font=font)
        draw.rectangle([x + 2, 0, x + 2 + (bbox[2] - bbox[0]) + 2, 11], fill=LABEL_BG)
        draw.text((x + 2, 0), label, fill=LABEL_COLOR, font=font)
    for y in range(0, height + 1, spacing):
        draw.line([(0, y), (width, y)], fill=GRID_COLOR, width=1)
        label = str(y)
        bbox = draw.textbbox((0, 0), label, font=font)
        draw.rectangle([0, y + 1, (bbox[2] - bbox[0]) + 2, y + 12], fill=LABEL_BG)
        draw.text((0, y + 1), label, fill=LABEL_COLOR, font=font)

    Image.alpha_composite(base, overlay).convert("RGB").save(out_path)
