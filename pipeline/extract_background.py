"""Extrait le CALQUE DÉCOR (fond de page sans texte) déjà produit par
`pdftohtml -c` et stocké en base64 dans dictionary.html.

Pourquoi c'est important : ce calque contient toutes les formes vectorielles,
dégradés, photos et logos de la page -- composités exactement comme dans le
PDF -- MAIS AUCUN TEXTE. C'est donc la seule source fiable pour reproduire
une décoration complexe (ruban avec encoche/repli d'ombre, cercles, bandes,
filigrane) : la redessiner en CSS/clipPath est un pari perdu d'avance dès que
la forme n'est pas un simple rectangle, et découper la capture cible à la
place bake le texte Jinja brut dans l'image.

Le calque est redimensionné à la taille EXACTE de la capture cible pour que
les coordonnées en pixels soient interchangeables entre les deux (le zoom
pdftohtml et le DPI pdftoppm ne tombent pas pile sur la même taille).

Usage: python3 extract_background.py <dictionary.html> <out.png> [width] [height]
"""
import base64
import re
import sys
from pathlib import Path

from PIL import Image

BG_RE = re.compile(r"background-image:url\(data:image/png;base64,([^)]+)\)")


def extract_background(dictionary_html_path, out_path, width=None, height=None):
    html_text = Path(dictionary_html_path).read_text(encoding="utf-8", errors="replace")
    match = BG_RE.search(html_text)
    if not match:
        raise SystemExit("Aucune image de fond trouvée dans le dictionnaire.")

    out_path = Path(out_path)
    out_path.write_bytes(base64.b64decode(match.group(1)))

    if width and height:
        img = Image.open(out_path)
        if img.size != (width, height):
            img.convert("RGBA").resize((width, height), Image.LANCZOS).save(out_path)
    return out_path


if __name__ == "__main__":
    dict_path, out_path = sys.argv[1], sys.argv[2]
    w = int(sys.argv[3]) if len(sys.argv) > 3 else None
    h = int(sys.argv[4]) if len(sys.argv) > 4 else None
    print(extract_background(dict_path, out_path, w, h))
