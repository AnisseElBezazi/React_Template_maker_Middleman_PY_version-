import sys
import json
from docx import Document

def replace_in_paragraph(paragraph, replacements):
    # Word coupe souvent une meme phrase en plusieurs <w:r> (verification
    # orthographique, limite de mise en forme...) : chercher run par run
    # rate silencieusement tout "search" qui chevauche cette coupure. On
    # recompose le texte du paragraphe entier avant de chercher/remplacer,
    # puis on le redepose dans le premier run (les autres sont vides).
    runs = paragraph.runs
    if not runs:
        return
    full_text = "".join(run.text for run in runs)
    new_text = full_text
    for search, replace in replacements.items():
        if not search or replace is None:
            continue
        if search in new_text:
            new_text = new_text.replace(search, replace)
    if new_text == full_text:
        return
    runs[0].text = new_text
    for run in runs[1:]:
        run.text = ""

def replace_text_in_doc(doc, replacements):
    # Iterate through paragraphs in the body
    for p in doc.paragraphs:
        replace_in_paragraph(p, replacements)

    # Iterate through tables
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    replace_in_paragraph(p, replacements)

def main():
    if len(sys.argv) != 4:
        print("Usage: python3 replace_in_docx.py <input.docx> <replacements.json> <output.docx>")
        sys.exit(1)

    input_path = sys.argv[1]
    replacements_path = sys.argv[2]
    output_path = sys.argv[3]

    try:
        with open(replacements_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # data is a list of {"search": "...", "replace": "..."}
            # Convert to dictionary for easier use
            replacements = {}
            for item in data:
                if 'search' in item and 'replace' in item:
                    replacements[item['search']] = item['replace']

        doc = Document(input_path)
        replace_text_in_doc(doc, replacements)
        doc.save(output_path)
        
        print(f"SUCCESS: {output_path}")
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
