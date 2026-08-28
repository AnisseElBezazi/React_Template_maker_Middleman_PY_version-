"""Transforme le dictionnaire de style (HTML brut et verbeux, positions +
balises incluses) en liste compacte position + texte + taille + couleur --
le même signal utile pour la passe 2 (couleurs/tailles exactes, ET position
pour les écarts d'alignement/espacement -- rien n'est ignoré, juste le
HTML/CSS autour), pour beaucoup moins de tokens (jusqu'à 40 000 caractères
de HTML deviennent quelques centaines de lignes courtes).

Usage: python3 compact_dictionary.py <dictionary.html>
Sortie: une ligne par texte -- "x,y|TAILLEpx|COULEUR|texte" -- sur stdout
"""
import html
import re
import sys
from pathlib import Path

CV_LINE_RE = re.compile(
    r'<span class="cv-line"[^>]*?left:([\d.]+)px;top:([\d.]+)px;'
    r'font-size:([\d.]+)px;color:([^;]+);[^>]*?>(.*?)</span>',
    re.DOTALL,
)
TAG_RE = re.compile(r"<[^>]+>")


def compact_entries(dictionary_html_path):
    html_text = Path(dictionary_html_path).read_text(encoding="utf-8", errors="replace")
    entries = []
    seen = set()
    for left, top, size_str, color, inner_html in CV_LINE_RE.findall(html_text):
        text = html.unescape(TAG_RE.sub("", inner_html)).replace("\xa0", " ").strip()
        if not text:
            continue
        x, y = round(float(left)), round(float(top))
        key = (x, y, text, size_str, color)
        if key in seen:
            continue
        seen.add(key)
        entries.append(f"{x},{y}|{float(size_str):g}px|{color}|{text}")
    return entries


if __name__ == "__main__":
    for line in compact_entries(sys.argv[1]):
        print(line)
