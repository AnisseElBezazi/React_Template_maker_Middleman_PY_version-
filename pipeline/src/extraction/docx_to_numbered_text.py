"""Extrait le texte d'un .docx avec un index devant chaque paragraphe -- le
CV CIBLE de la pipeline jinja (pas l'exemple de style) doit etre montre sous
cette forme : Kimi reference un paragraphe par son index plutot que de devoir
recopier son texte caractere pour caractere pour que replace_in_docx.py le
retrouve (fragile : espaces insecables, paragraphes dupliques, listes a puces
coupees en plusieurs paragraphes...).

Usage: python3 docx_to_numbered_text.py <docx_path>  (ecrit sur stdout)
"""
import sys

from docx import Document
from docx_blocks import iter_document_paragraphs_with_context, paragraph_text


def docx_to_numbered_text(docx_path):
    doc = Document(docx_path)
    lines = []
    for i, (p, ctx, zones) in enumerate(iter_document_paragraphs_with_context(doc)):
        # Un paragraphe = une ligne numerotee ; un saut de ligne manuel a
        # l'interieur ne doit pas casser cette correspondance 1-pour-1.
        text = paragraph_text(p).replace("\n", " ").strip()
        if text:
            tags = []
            # Signale un paragraphe d'en-tete/pied de page (se repete sur
            # CHAQUE page, contrairement a un paragraphe de corps) et/ou une
            # forme/zone de texte (pastille, encadre) -- sans ca, rien ne
            # distingue ces paragraphes d'un paragraphe normal, et le modele
            # peut croire a tort qu'un champ n'existe nulle part dans le CV.
            tags.extend(zones)
            # Signale un paragraphe dans un tableau (ligne/colonne) : sans
            # ca, le modele ne peut pas savoir qu'il lui faut une balise
            # `{%tr%}` plutot que `{%p%}` pour une boucle ici.
            if ctx:
                r_idx, row_count, c_idx, col_count = ctx[-1]
                tags.append(f"tableau, ligne {r_idx + 1}/{row_count}, colonne {c_idx + 1}/{col_count}")
            tag = f" ({', '.join(tags)})" if tags else ""
            lines.append(f"[{i}]{tag} {text}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(docx_to_numbered_text(sys.argv[1]))
