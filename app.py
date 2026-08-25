import shutil

from flask import Flask, jsonify, render_template, request

from converter import pdf_to_html

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 30 Mo


@app.route("/")
def index():
    pdftohtml_missing = shutil.which("pdftohtml") is None
    return render_template("index.html", pdftohtml_missing=pdftohtml_missing)


@app.route("/convert", methods=["POST"])
def convert():
    if "pdf" not in request.files:
        return jsonify({"error": "Aucun fichier reçu."}), 400

    file = request.files["pdf"]
    if not file.filename:
        return jsonify({"error": "Aucun fichier sélectionné."}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Le fichier doit être un PDF."}), 400

    try:
        html_output = pdf_to_html(file.read())
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"html": html_output, "filename": file.filename.rsplit(".", 1)[0] + ".html"})


if __name__ == "__main__":
    app.run(debug=True, port=5001)
