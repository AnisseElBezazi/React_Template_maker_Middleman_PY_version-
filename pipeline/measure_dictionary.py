"""Passe 4 (algorithmique, sans IA) -- étape 1/2 : mesure la taille RÉELLE
(en px, à l'échelle de l'image cible grâce au correctif de zoom) des textes
de titres statiques présents tels quels dans le dictionnaire de style
(FORMATIONS, COMPÉTENCES, etc. -- du texte de mise en page, pas des
données candidat, donc identique entre le PDF brut et le composant généré).

Usage: python3 measure_dictionary.py <dictionary.html>
Sortie: JSON {"TEXTE": taille_px, ...} sur stdout
"""
import html
import json
import re
import sys
from pathlib import Path

CV_LINE_RE = re.compile(r'<span class="cv-line"[^>]*?font-size:([\d.]+)px[^>]*?>(.*?)</span>', re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")


def heading_sizes(dictionary_html_path):
    html_text = Path(dictionary_html_path).read_text(encoding="utf-8", errors="replace")
    sizes = {}
    for size_str, inner_html in CV_LINE_RE.findall(html_text):
        text = html.unescape(TAG_RE.sub("", inner_html)).replace("\xa0", " ").strip()
        if not text or len(text) > 40 or not any(c.isalpha() for c in text):
            continue
        # Titre probable : texte tout en majuscules -- stable, non lié aux
        # données candidat, donc comparable au composant généré.
        if text.upper() != text:
            continue
        key = text.upper()
        size = float(size_str)
        if key not in sizes or size > sizes[key]:
            sizes[key] = size
    return sizes


if __name__ == "__main__":
    print(json.dumps(heading_sizes(sys.argv[1]), ensure_ascii=False))
