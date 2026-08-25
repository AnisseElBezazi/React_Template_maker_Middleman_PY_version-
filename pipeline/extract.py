"""Extraction step (Étape 1 de la pipeline Design-to-Code).

Réutilise le convertisseur PDF->HTML existant comme "dictionnaire de style"
(couleurs hex exactes, tailles, texte précis), pdftoppm pour la capture
d'écran haute qualité qui sert de cible visuelle à l'IA, et extrait les
tags Jinja bruts ({{ ... }} / {% ... %}) présents sur cette page -- ce sont
les chemins de données exacts (data.personal_information.trigram, etc.) que
le nouveau composant doit lire dans cvData, pas de texte inventé.

Ne traite QUE la page demandée -- inutile de rasteriser/parser tout le
document quand une seule page sera utilisée par la pipeline.

Usage: python3 extract.py <pdf_path> <out_dir> <page_number>
Produit dans <out_dir>: target-<page>.png, dictionary.html, jinja_tags.json
"""
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from converter import (  # noqa: E402
    pdf_to_html, run_pdftohtml_complex, parse_css_classes, parse_runs,
    estimate_geometry, cluster_columns, PAGE_DIV_RE,
)
import subprocess  # noqa: E402
from PIL import Image  # noqa: E402


MIN_EXTRACTED_IMAGE_SIZE = 10


def extract_embedded_images(pdf_path, out_dir, page):
    """Les images de fond/logos ne doivent pas être inventées ni remplacées
    par un placeholder : on les extrait telles quelles depuis le PDF
    (pdfimages, poppler) et le composant généré doit les réutiliser. Un
    objet image avec transparence est exporté par pdfimages comme deux
    fichiers séparés (l'image RGB + son masque alpha en niveaux de gris,
    partageant le même "object ID") -- on les recompose en un seul PNG RGBA
    pour que la transparence soit correcte."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        list_result = subprocess.run(
            ["pdfimages", "-png", "-list", "-f", str(page), "-l", str(page), str(pdf_path)],
            capture_output=True, text=True,
        )
        # Colonnes : page num type width height color comp bpc enc interp objectID x-ppi y-ppi size ratio
        rows = [ln.split() for ln in list_result.stdout.strip().splitlines()[2:] if ln.strip()]

        prefix = tmp_dir / "raw"
        run_result = subprocess.run(
            ["pdfimages", "-png", "-f", str(page), "-l", str(page), str(pdf_path), str(prefix)],
            capture_output=True, text=True,
        )
        if run_result.returncode != 0:
            return []

        raw_files = sorted(tmp_dir.glob("raw-*.png"))
        extracted = []
        i = 0
        while i < len(raw_files):
            img = Image.open(raw_files[i])
            is_paired_smask = (
                i + 1 < len(raw_files)
                and Image.open(raw_files[i + 1]).size == img.size
                and i < len(rows) and i + 1 < len(rows)
                and len(rows[i]) > 10 and len(rows[i + 1]) > 10
                and rows[i][10] == rows[i + 1][10]
                and rows[i][2] == "image" and rows[i + 1][2] == "smask"
            )
            if is_paired_smask:
                mask = Image.open(raw_files[i + 1]).convert("L")
                img = img.convert("RGB")
                img.putalpha(mask)
                i += 2
            else:
                i += 1

            if img.width >= MIN_EXTRACTED_IMAGE_SIZE and img.height >= MIN_EXTRACTED_IMAGE_SIZE:
                idx = len(extracted) + 1
                out_path = out_dir / f"extracted-{idx}.png"
                img.save(out_path)
                extracted.append({"path": str(out_path), "width": img.width, "height": img.height})
        return extracted


def _find_tags(text):
    tags = re.findall(r"\{\{.*?\}\}|\{%.*?%\}", text)
    return [re.sub(r"\s+", " ", t).strip() for t in tags]


def extract_jinja_tags(pdf_path, page):
    """Repart d'un parsing brut (avant toute réorganisation en blocs) pour
    reconstruire le texte de la page dans son ordre de lecture d'origine --
    en respectant les colonnes : un simple tri global par (top, left)
    entrelace les colonnes gauche/droite ligne par ligne et fragmente les
    tags Jinja au milieu dès qu'un template a une mise en page à 2 colonnes."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        page_numbers = run_pdftohtml_complex(pdf_path, tmp_dir, first_page=page, last_page=page)
        html_text = (tmp_dir / f"page-{page_numbers[0]}.html").read_text(encoding="utf-8", errors="replace")

    dims = PAGE_DIV_RE.search(html_text)
    page_width = float(dims.group(1)) if dims else 1000.0

    css_classes = parse_css_classes(html_text)
    runs = parse_runs(html_text, css_classes)
    estimate_geometry(runs)

    seen, unique = set(), []
    for column in cluster_columns(runs, page_width):
        column.sort(key=lambda r: (r["top"], r["left"]))
        full_text = " ".join(r["text_plain"] for r in column)
        for tag in _find_tags(full_text):
            if tag not in seen:
                seen.add(tag)
                unique.append(tag)
    return unique, page_width


def main():
    pdf_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    page = int(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)

    pdf_bytes = pdf_path.read_bytes()

    # Rendu cible : uniquement la page demandée, fidèle à un vrai lecteur PDF.
    # Fait EN PREMIER : sa largeur en pixels sert de référence d'échelle pour
    # tout le reste (voir plus bas).
    result = subprocess.run(
        ["pdftoppm", "-png", "-r", "150", "-f", str(page), "-l", str(page), str(pdf_path), str(out_dir / "target")],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pdftoppm a échoué: {result.stderr.strip()}")
    targets = sorted(out_dir.glob("target*.png"))
    if not targets:
        raise RuntimeError(f"pdftoppm n'a produit aucune image pour la page {page}.")
    target_width = Image.open(targets[0]).width

    # Tags Jinja bruts de cette page uniquement -- rien d'autre. Au passage,
    # ça nous donne la largeur de page que pdftohtml produit à son zoom par
    # défaut (~108dpi), qu'on compare à celle de la cible (150dpi) pour
    # calculer le zoom exact à appliquer au dictionnaire de style ci-dessous
    # -- sans ça, ses tailles de police/positions sont toutes décalées d'un
    # facteur constant (~1.39x) par rapport à l'image que l'IA regarde.
    jinja_tags, default_pdftohtml_width = extract_jinja_tags(pdf_path, page)
    (out_dir / "jinja_tags.json").write_text(json.dumps(jinja_tags, ensure_ascii=False, indent=2), encoding="utf-8")
    # pdftohtml's own default zoom is 1.5 (not 1) -- the ratio must scale
    # relative to that, not replace it outright.
    PDFTOHTML_DEFAULT_ZOOM = 1.5
    zoom = PDFTOHTML_DEFAULT_ZOOM * (target_width / default_pdftohtml_width)

    # Dictionnaire de style : le HTML produit par le convertisseur existant,
    # limité à la page ciblée, à la MÊME échelle que l'image cible.
    dictionary_html = pdf_to_html(pdf_bytes, first_page=page, last_page=page, zoom=zoom)
    (out_dir / "dictionary.html").write_text(dictionary_html, encoding="utf-8")

    # Images intégrées réelles de cette page (photos de fond, logos) --
    # jamais inventées, jamais un placeholder : ce sont les vrais fichiers.
    extracted_images = extract_embedded_images(pdf_path, out_dir, page)
    (out_dir / "extracted_images.json").write_text(
        json.dumps(extracted_images, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("DICTIONARY:" + str(out_dir / "dictionary.html"))
    print("JINJA_TAGS:" + str(out_dir / "jinja_tags.json"))
    print("EXTRACTED_IMAGES:" + str(out_dir / "extracted_images.json"))
    print("TARGET:" + str(targets[0]))


if __name__ == "__main__":
    main()
