"""Réduit une image avant de l'envoyer au modèle.

Le coût vision est proportionnel au nombre de pixels (~largeur*hauteur/750
tokens) : un logo extrait en 2425x899 coûte ~2900 tokens, autant que la page
entière, alors qu'il sert seulement à être RECONNU, pas mesuré au pixel. Le
ramener sur son plus grand côté suffit largement.

Usage: python3 shrink_for_vision.py <source> <destination> [côté max]
Sortie: le chemin écrit (l'original est copié tel quel s'il est déjà petit)
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

MAX_SIDE = 800


def shrink(src, dest, max_side=MAX_SIDE):
    img = Image.open(src)
    if max(img.size) <= max_side:
        if str(src) != str(dest):
            shutil.copyfile(src, dest)
        return dest
    ratio = max_side / max(img.size)
    img.convert("RGBA").resize(
        (max(1, round(img.width * ratio)), max(1, round(img.height * ratio))),
        Image.LANCZOS,
    ).save(dest)
    return dest


if __name__ == "__main__":
    src, dest = sys.argv[1], sys.argv[2]
    side = int(sys.argv[3]) if len(sys.argv) > 3 else MAX_SIDE
    print(shrink(src, dest, side))
