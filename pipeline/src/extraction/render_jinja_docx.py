import sys
import json
from docxtpl import DocxTemplate

def main():
    if len(sys.argv) != 4:
        print("Usage: python3 render_jinja_docx.py <template.docx> <data.json> <output.docx>")
        sys.exit(1)

    template_path = sys.argv[1]
    data_path = sys.argv[2]
    output_path = sys.argv[3]

    try:
        with open(data_path, 'r', encoding='utf-8') as f:
            context = json.load(f)
            
        doc = DocxTemplate(template_path)
        doc.render(context)
        doc.save(output_path)
        
        print(f"SUCCESS: {output_path}")
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
