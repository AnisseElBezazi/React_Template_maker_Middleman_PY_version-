"""Découpe une région rectangulaire d'une image -- utilisé pour récupérer un
élément graphique vectoriel (un logo dessiné en formes PDF, pas une image
bitmap), ou un bandeau composite entier (photo + logos), directement depuis
le screenshot cible, la seule source qui les rende réellement puisque
pdfimages ne peut pas les extraire.

La zone demandée est une ESTIMATION visuelle de l'IA, pas des coordonnées
pixel-perfect -- elle déborde parfois de quelques pixels sur la zone
voisine (ex: un fin liseré blanc du fond de page qui dépasse sous un
bandeau sombre). On rogne donc après coup toute bordure de couleur
uniforme qui détonne nettement du reste de la découpe.

Usage: python3 crop_image.py <src_png> <x> <y> <width> <height> <out_png>
Coordonnées en pixels, origine en haut à gauche, comme sur l'image source.
"""
import statistics
import sys
from PIL import Image

MAX_TRIM_RATIO = 0.15  # ne jamais rogner plus de 15% d'un côté
UNIFORM_STDDEV = 10  # une ligne/colonne "unie" a une variation interne faible
DIFF_FROM_CORE = 35  # écart (somme des différences RGB) pour dire "détonne"


def _row_color(pixels, y, width, step):
    samples = [pixels[x, y] for x in range(0, width, step)]
    r = statistics.mean(p[0] for p in samples)
    g = statistics.mean(p[1] for p in samples)
    b = statistics.mean(p[2] for p in samples)
    spread = statistics.pstdev([sum(p[:3]) for p in samples])
    return (r, g, b), spread


def _col_color(pixels, x, height, step):
    samples = [pixels[x, y] for y in range(0, height, step)]
    r = statistics.mean(p[0] for p in samples)
    g = statistics.mean(p[1] for p in samples)
    b = statistics.mean(p[2] for p in samples)
    spread = statistics.pstdev([sum(p[:3]) for p in samples])
    return (r, g, b), spread


def _color_dist(a, b):
    return sum(abs(a[i] - b[i]) for i in range(3))


def trim_stray_border(img):
    """Renvoie (left, top, right, bottom) à rogner en plus, en détectant
    depuis chaque bord une bande unie qui ne ressemble pas au coeur de
    l'image (le contenu qu'on voulait vraiment découper)."""
    w, h = img.size
    if w < 6 or h < 6:
        return (0, 0, 0, 0)
    rgb = img.convert("RGB")
    pixels = rgb.load()
    step_x = max(1, w // 40)
    step_y = max(1, h // 40)

    core = rgb.crop((w // 4, h // 4, w - w // 4, h - h // 4))
    core_pixels = list(core.getdata())
    core_color = (
        statistics.mean(p[0] for p in core_pixels),
        statistics.mean(p[1] for p in core_pixels),
        statistics.mean(p[2] for p in core_pixels),
    )

    max_top = int(h * MAX_TRIM_RATIO)
    max_bottom = int(h * MAX_TRIM_RATIO)
    max_left = int(w * MAX_TRIM_RATIO)
    max_right = int(w * MAX_TRIM_RATIO)

    top = 0
    for y in range(max_top):
        color, spread = _row_color(pixels, y, w, step_x)
        if spread < UNIFORM_STDDEV and _color_dist(color, core_color) > DIFF_FROM_CORE:
            top = y + 1
        else:
            break

    bottom = 0
    for i in range(max_bottom):
        y = h - 1 - i
        color, spread = _row_color(pixels, y, w, step_x)
        if spread < UNIFORM_STDDEV and _color_dist(color, core_color) > DIFF_FROM_CORE:
            bottom = i + 1
        else:
            break

    left = 0
    for x in range(max_left):
        color, spread = _col_color(pixels, x, h, step_y)
        if spread < UNIFORM_STDDEV and _color_dist(color, core_color) > DIFF_FROM_CORE:
            left = x + 1
        else:
            break

    right = 0
    for i in range(max_right):
        x = w - 1 - i
        color, spread = _col_color(pixels, x, h, step_y)
        if spread < UNIFORM_STDDEV and _color_dist(color, core_color) > DIFF_FROM_CORE:
            right = i + 1
        else:
            break

    return (left, top, right, bottom)


def main():
    src, x, y, w, h, out = sys.argv[1:7]
    x, y, w, h = int(float(x)), int(float(y)), int(float(w)), int(float(h))
    img = Image.open(src).convert("RGBA")
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(img.width, x + w), min(img.height, y + h)
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"Zone de découpe invalide/hors image: ({x},{y},{w},{h}) dans {img.size}")
    cropped = img.crop((x0, y0, x1, y1))

    left, top, right, bottom = trim_stray_border(cropped)
    if left or top or right or bottom:
        cw, ch = cropped.size
        cropped = cropped.crop((left, top, cw - right, ch - bottom))

    cropped.save(out)


if __name__ == "__main__":
    main()
