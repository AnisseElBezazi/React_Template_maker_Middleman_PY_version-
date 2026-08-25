"""Extraction de texte brut depuis un .docx (word/document.xml), sans
dépendance externe -- juste ce qu'il faut pour nourrir les prompts
d'extraction cvData avec le texte d'un vrai CV.

Usage: python3 docx_to_text.py <docx_path>  (écrit le texte sur stdout)
"""
import html
import re
import sys
import zipfile


def docx_to_text(docx_path):
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    # Un saut de paragraphe par </w:p>, garde les tabulations de </w:tab>.
    xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t")
    text = re.sub(r"<[^>]+>", "", xml)
    return html.unescape(text)


if __name__ == "__main__":
    print(docx_to_text(sys.argv[1]))
