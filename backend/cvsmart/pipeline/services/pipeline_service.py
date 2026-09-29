import base64
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from cvsmart.shared.paths_service import NODE_TOOLS_ROOT, PIPELINE_SAMPLE_CVDATA
from cvsmart.shared.errors import RunCancelled
from cvsmart.jsx.services.sample_data_service import generate_sample_cv_data
from cvsmart.jsx.services.audit_service import audit_jsx
from cvsmart.jsx.services.text_safety_service import add_text_safety
from cvsmart.rendering.services.render_service import render as render_component
from cvsmart.rendering.services.grid_service import add_grid_overlay
from cvsmart.rendering.services.diff_service import generate_diff_image
from cvsmart.rendering.services.target_service import png_size
from cvsmart.rendering.services.dom_measure_service import measure_dom_sizes, measure_dom_texts
from cvsmart.pipeline.services.model_client_service import ModelClient
from cvsmart.pipeline.services.jsx_artifacts_service import (
    place_extracted_images, crop_extra_images, save_assets_map,
)
from cvsmart.pipeline.services.prompt_helpers import (
    read_prompt_template, read_template_file, extract_code, assert_valid_jsx,
    ensure_root_max_width, fix_double_assets_prefix,
)

EXTRACT_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "extract.py"
EXTRACT_BACKGROUND_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "extract_background.py"
COMPACT_DICTIONARY_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "compact_dictionary.py"
MEASURE_DICTIONARY_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "measure_dictionary.py"
SHRINK_FOR_VISION_PY = NODE_TOOLS_ROOT / "src" / "rendering" / "shrink_for_vision.py"


def _noop_progress(step: str, message: str) -> None:
    pass


def _noop_stream(step: str, kind: str, text: str) -> None:
    pass


@dataclass
class PipelineResult:
    out_dir: Path
    target_path: Path
    dictionary_path: Path
    width: int
    height: int
    passes: list[dict]
    per_pass_usage: list
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: int
    total_cache_write_tokens: int


def run_pipeline(
    pdf_path: Path,
    out_dir: Path,
    api_key: str,
    page_number: str = "all",
    # Effort de raisonnement de la passe 1 (low/high/max). C'est la passe qui
    # concoit le composant : sur un template complexe, monter a `max` peut
    # valoir son surcout, alors que sur un template simple c'est de l'argent
    # jete -- le raisonnement est facture comme de la sortie.
    pass1_effort: str = "high",
    cv_data_path: Path | None = None,
    extra_config_path: Path | None = None,
    # Coche manuelle cote UI : le test de detection automatique de la page de
    # couverture (voir pass1.md) se trompe parfois (page 1 avec de vrais
    # blocs de contenu en plus de l'identite). Plutot que de dependre a 100%
    # du modele, l'utilisateur peut trancher lui-meme quand il sait deja --
    # ca court-circuite le test au lieu de le renforcer indefiniment.
    has_cover_page: bool = False,
    on_progress: Callable[[str, str], None] = _noop_progress,
    on_stream: Callable[[str, str, str], None] = _noop_stream,
    should_cancel: Callable[[], bool] = lambda: False,
) -> PipelineResult:
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF introuvable: {pdf_path}")
    if not api_key:
        raise RuntimeError("Clé API manquante.")

    # Chaque etape de la pipeline annonce sa progression via on_progress --
    # on verifie l'annulation ici une seule fois plutot que devant chacun
    # des ~15 appels, pour que "Annuler" reagisse partout sans y toucher.
    _inner_on_progress = on_progress

    def on_progress(step: str, message: str) -> None:
        if should_cancel():
            raise RunCancelled("Run annulé par l'utilisateur.")
        _inner_on_progress(step, message)

    out_dir.mkdir(parents=True, exist_ok=True)
    python_bin = sys.executable

    cv_data_path = cv_data_path or PIPELINE_SAMPLE_CVDATA
    using_custom_schema = False

    # --- Etape 1 : extraction (screenshots cibles + dictionnaire de style) ---
    all_pages = str(page_number).lower() == "all"
    on_progress("extract", "Génération des screenshots cibles et du dictionnaire HTML (toutes les pages)..."
                if all_pages else f"Génération du screenshot cible et du dictionnaire HTML (page {page_number})...")
    extract_result = subprocess.run(
        [python_bin, str(EXTRACT_PY), str(pdf_path), str(out_dir), "all" if all_pages else str(page_number)],
        capture_output=True, text=True,
    )
    if extract_result.returncode != 0:
        raise RuntimeError(f"Extraction échouée: {extract_result.stderr}")

    lines = extract_result.stdout.strip().split("\n")
    def _find(prefix):
        return next((l[len(prefix):] for l in lines if l.startswith(prefix)), None)
    dictionary_path = Path(_find("DICTIONARY:"))
    dictionary_notext_raw = _find("DICTIONARY_NOTEXT:")
    dictionary_notext_path = Path(dictionary_notext_raw) if dictionary_notext_raw else dictionary_path
    jinja_tags_path = _find("JINJA_TAGS:")
    extracted_images_path = _find("EXTRACTED_IMAGES:")
    target_paths = [Path(l[len("TARGET:"):]) for l in lines if l.startswith("TARGET:")]
    if not target_paths:
        raise RuntimeError("Aucune image cible produite par extract.py.")
    target_path = target_paths[0]
    page_count = len(target_paths)

    width, height = png_size(target_path)
    jinja_tags = json.loads(Path(jinja_tags_path).read_text(encoding="utf-8")) if jinja_tags_path else []
    extracted_images = json.loads(Path(extracted_images_path).read_text(encoding="utf-8")) if extracted_images_path else []
    # Si un extra_config (schema CvParserConfig du client/template reel) est
    # fourni, il remplace le schema generique : chaque template peut avoir
    # des champs différents, donc un schéma unique pour tous ne colle pas
    # toujours -- certains champs manquent et le modele peut inventer des
    # noms de champs qui n'existent pas pour CE client precis. Fait APRES
    # l'extraction (pas avant) pour pouvoir passer les vraies balises Jinja :
    # un champ qu'elles referencent (`data.xxx`) mais que CET extra_config
    # precis ne declare pas est comble depuis le schema generique plutot que
    # de rester vide dans l'apercu (voir generate_sample_cv_data).
    if extra_config_path:
        extra_config = json.loads(Path(extra_config_path).read_text(encoding="utf-8"))
        generated = generate_sample_cv_data(extra_config, jinja_tags=jinja_tags)
        cv_data_path = out_dir / "generated_cvdata.json"
        cv_data_path.write_text(json.dumps(generated, indent=2, ensure_ascii=False), encoding="utf-8")
        using_custom_schema = True

    on_progress("extract", f"{page_count} page(s) cible ({width}x{height}px), {len(jinja_tags)} tag(s) Jinja, "
                            f"{len(extracted_images)} image(s) extraite(s).")

    # Calque décor : le fond de page SANS TEXTE que pdftohtml -c produit déjà.
    # C'est la seule reference fiable pour une decoration complexe.
    background_paths: list[Path | None] = []
    for i in range(page_count):
        bg_path = out_dir / f"background-layer-{i + 1}.png"
        bg_result = subprocess.run(
            [python_bin, str(EXTRACT_BACKGROUND_PY), str(dictionary_notext_path), str(bg_path), str(width), str(height), str(i + 1)],
            capture_output=True, text=True,
        )
        background_paths.append(bg_path if bg_result.returncode == 0 and bg_path.exists() else None)
    has_background = any(background_paths)
    on_progress("extract", f"Calque décor (fond sans texte) extrait pour {sum(1 for b in background_paths if b)}/{page_count} page(s)."
                if has_background else "Calque décor indisponible -- les découpes retomberont sur la capture cible.")

    # Dictionnaire compact (texte+taille+couleur, sans le HTML/CSS autour).
    compact_result = subprocess.run([python_bin, str(COMPACT_DICTIONARY_PY), str(dictionary_path)], capture_output=True, text=True)
    dictionary_compact = compact_result.stdout if compact_result.returncode == 0 and compact_result.stdout.strip() \
        else dictionary_path.read_text(encoding="utf-8")[:40000]
    jinja_tags_text = "\n".join(jinja_tags) if jinja_tags else "(aucun tag Jinja détecté sur cette page)"

    # On plafonne a 8 images pour ne pas exploser le cout de la passe 1 en
    # tokens de vision.
    top_images = sorted(extracted_images, key=lambda img: img["width"] * img["height"], reverse=True)[:8]
    extracted_images_text = "\n".join(
        f"extracted-{extracted_images.index(img) + 1} : {img['width']}x{img['height']}px" for img in top_images
    ) if top_images else "(aucune image intégrée trouvée sur cette page)"

    vision_dir = out_dir / "vision"
    vision_dir.mkdir(parents=True, exist_ok=True)
    extracted_image_blocks = []
    for img in top_images:
        idx = extracted_images.index(img) + 1
        small = vision_dir / f"extracted-{idx}.png"
        shrunk = subprocess.run([python_bin, str(SHRINK_FOR_VISION_PY), img["path"], str(small)], capture_output=True, text=True)
        send_path = small if shrunk.returncode == 0 and small.exists() else Path(img["path"])
        extracted_image_blocks.append({"type": "text", "text": f"Image extraite extracted-{idx} (dimensions réelles {img['width']}x{img['height']}px) :"})
        extracted_image_blocks.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                                     "data": base64.b64encode(send_path.read_bytes()).decode()}})

    golden_reference = "\n\n".join([
        "--- MOTEUR UNIVERSEL (ne pas réécrire -- importer tel quel via les mêmes chemins @/components/CvSmart/templates/engine/...) ---",
        "// engine/paginationEngine.js", read_template_file("engine/paginationEngine.js"),
        "// engine/usePaginatedGroups.js", read_template_file("engine/usePaginatedGroups.js"),
        "// engine/PaginatedEntryPages.jsx", read_template_file("engine/PaginatedEntryPages.jsx"),
        "// engine/entryFragments.jsx", read_template_file("engine/entryFragments.jsx"),
        "--- EXEMPLE COMPLET DÉJÀ INTÉGRÉ EN PRODUCTION (template Visian -- sert de patron de conventions, NE PAS le reproduire pour un autre template) ---",
        "// VisianTemplateHtml.jsx", read_template_file("VisianTemplateHtml.jsx"),
        "--- SCHÉMA cvData -- SPÉCIFIQUE à ce client/template précis (dérivé de son extra_config réel, pas un schéma générique) -- utiliser EXACTEMENT ces noms de champs, ne pas réutiliser ceux d'un autre template CV Smart ---"
        if using_custom_schema else
        "--- SCHÉMA cvData (générique, aucun extra_config fourni pour ce test -- utiliser EXACTEMENT ces noms de champs) ---",
        Path(cv_data_path).read_text(encoding="utf-8"),
    ])

    # Une entree par page cible. Le marqueur de cache est pose sur la
    # DERNIERE image : le cache ne s'accroche que sur un prefixe complet.
    target_image_blocks = []
    for i, tp in enumerate(target_paths):
        if page_count > 1:
            target_image_blocks.append({"type": "text", "text": f"PAGE {i + 1}/{page_count} -- image CIBLE :"})
        block = {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                              "data": base64.b64encode(tp.read_bytes()).decode()}}
        if i == page_count - 1:
            block["cache_control"] = {"type": "ephemeral"}
        target_image_blocks.append(block)

    client = ModelClient(api_key=api_key, on_progress=on_progress, on_stream=on_stream, should_cancel=should_cancel)

    def render(jsx_path: Path, png_out_path: Path) -> list[Path]:
        result = render_component(jsx_path, cv_data_path, png_out_path, width, height)
        if result["errors"]:
            on_progress("render", f"Avertissement -- erreurs JS dans le composant rendu: {result['errors']}")
        return result["page_paths"]

    passes = []

    # --- Passe 1 : premier jet (structure + layout) ---
    # Cadrage du perimetre : une seule page, ou le template entier. Sans ce
    # cadrage, un envoi multi-pages est lu comme plusieurs variantes de la
    # meme page et le modele n'en reproduit qu'une.
    if page_count > 1:
        page_scope_text = "\n".join([
            f"PÉRIMÈTRE : tu dois reproduire le template ENTIER, soit {page_count} pages. Les {page_count} images cibles te sont fournies ci-dessous, dans l'ordre, chacune annoncée par \"PAGE k/{page_count}\".",
            f"Ce ne sont PAS {page_count} variantes de la même page ni {page_count} templates différents : c'est UN SEUL document, à rendre par UN SEUL composant.",
            f"Attention à ne pas confondre deux choses : le NOMBRE de pages du document final n'est pas figé -- c'est le moteur de pagination qui en émet autant que les vraies données l'exigent, et il peut donc y en avoir plus ou moins que {page_count}.",
            f"Ce que les images cibles te montrent, c'est l'HABILLAGE de chaque page (en-tête, pied de page, bandeaux, filigranes, marges) et l'ORDRE des sections. Si les pages 2 et suivantes partagent le même habillage, écris-le UNE fois et laisse le moteur le répéter ; ne code jamais \"{page_count} pages\" en dur.",
            "Si une page a un habillage à part (page de couverture, dernière page), reproduis-le comme tel -- une page de couverture (identité/accroche seule, ou résumé tronqué) doit être un bloc JSX séparé à hauteur fixe, JAMAIS un item envoyé au moteur de pagination (voir la règle dédiée plus bas) : sinon le moteur remplit l'espace restant de cette page avec le contenu suivant (expériences...).",
            f'Pour une découpe EXTRA_IMAGES, ajoute le champ "page" (1-{page_count}) indiquant de quelle page viennent les coordonnées : EXTRA_IMAGES:[{{"index": 10, "page": 2, "x": 1050, "y": 15, "width": 90, "height": 70}}]. Sans ce champ, la découpe est faite sur la page 1.',
        ])
        if has_cover_page:
            # L'utilisateur a coche la case "page de couverture" cote UI : il
            # a deja regarde le PDF, pas besoin de faire deviner au modele ce
            # qu'il sait deja -- le test de detection automatique (voir
            # pass1.md) se trompe parfois quand la page 1 affiche aussi de
            # vrais blocs de contenu en plus de l'identite.
            page_scope_text += "\n" + (
                "CONFIRMATION EXPLICITE DE L'UTILISATEUR : la PAGE 1 de ce template EST une page à part "
                "(habillage différent des pages suivantes) -- ne cherche PAS à le déterminer toi-même via le "
                "test de détection, c'est déjà tranché. Applique DIRECTEMENT la RÈGLE MÉCANIQUE dédiée plus bas : "
                "la page 1 doit être un bloc JSX séparé à hauteur fixe, rendu AVANT et EN DEHORS de tout appel à "
                "`PaginatedEntryPages`, jamais comme item de son flux -- quel que soit le contenu qu'elle affiche."
            )
    else:
        page_scope_text = "PÉRIMÈTRE : une seule page t'est fournie, tu ne reproduis que celle-là."

    pass1_template = read_prompt_template("pass1.md")
    pass1_before, pass1_after = pass1_template.split("{{GOLDEN_REFERENCE}}")
    def _fill(part: str) -> str:
        return (part.replace("{{PAGE_SCOPE}}", page_scope_text)
                    .replace("{{CANVAS_SIZE}}", f"{width} x {height}")
                    .replace("{{JINJA_TAGS}}", jinja_tags_text)
                    .replace("{{EXTRACTED_IMAGES}}", extracted_images_text))
    pass1_before, pass1_after = _fill(pass1_before), _fill(pass1_after)

    background_image_blocks = []
    for i, bg_path in enumerate(background_paths):
        if not bg_path:
            continue
        page_note = f" DE LA PAGE {i + 1}/{page_count}" if page_count > 1 else ""
        crop_note = f' (utilise "page": {i + 1} pour découper ici)' if page_count > 1 else ""
        background_image_blocks.append({"type": "text", "text":
            f"CALQUE DÉCOR{page_note} (même repère que l'image cible, {width} x {height}) -- toutes les formes/photos/logos de la page, SANS AUCUN TEXTE. C'est ta source pour toute découpe EXTRA_IMAGES{crop_note} :"})
        background_image_blocks.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                                      "data": base64.b64encode(bg_path.read_bytes()).decode()}})

    jsx1_raw = client.call("pass1", [
        *target_image_blocks,
        {"type": "text", "text": pass1_before},
        {"type": "text", "text": golden_reference, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": pass1_after},
        *background_image_blocks,
        *extracted_image_blocks,
    ], effort=pass1_effort)
    jsx1 = fix_double_assets_prefix(ensure_root_max_width(extract_code(jsx1_raw)))
    assert_valid_jsx(jsx1, "1")
    jsx1_path = out_dir / "attempt1.jsx"
    jsx1_path.write_text(jsx1, encoding="utf-8")
    crop_extra_images(jsx1_raw, target_paths, out_dir, python_bin)
    save_assets_map(jsx1_raw, out_dir)
    place_extracted_images(jsx1, out_dir)
    png1_path = out_dir / "attempt1.png"
    on_progress("pass1", "Rendu de la tentative 1...")
    pass1_page_paths = render(jsx1_path, png1_path)
    passes.append({"name": "pass1", "label": "Passe 1 -- premier jet", "jsx_path": jsx1_path, "png_path": png1_path,
                    "html_path": png1_path.with_suffix(".html")})
    on_progress("pass1", "OK")

    # --- Passe 2 : diff visuel + auto-correction ---
    on_progress("pass2", "Génération de la grille de repères et de l'image de différence...")
    try:
        render_page_paths = pass1_page_paths if pass1_page_paths else [png1_path]
        comparable = min(page_count, len(render_page_paths))
        if not comparable:
            raise RuntimeError("aucune page rendue a comparer")

        pass2_image_blocks = []
        ratios = []
        for i in range(comparable):
            try:
                suffix = f"-p{i + 1}" if page_count > 1 else ""
                target_grid_path = out_dir / f"target-grid{suffix}.png"
                render_grid_path = out_dir / f"attempt1-grid{suffix}.png"
                diff_path = out_dir / f"diff1{suffix}.png"
                diff_grid_path = out_dir / f"diff1-grid{suffix}.png"
                add_grid_overlay(target_paths[i], target_grid_path, width, height)
                add_grid_overlay(render_page_paths[i], render_grid_path, width, height)
                diff_stats = generate_diff_image(target_paths[i], render_page_paths[i], diff_path)
                add_grid_overlay(diff_path, diff_grid_path, width, height)
                ratios.append(diff_stats["diff_ratio"])
                label = f"PAGE {i + 1}/{page_count} -- " if page_count > 1 else ""
                pass2_image_blocks += [
                    {"type": "text", "text": f"{label}Image 1 (CIBLE, grille de repères tous les 50px) :"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(target_grid_path.read_bytes()).decode()}},
                    {"type": "text", "text": f"{label}Image 2 (TON RENDU ACTUEL, meme grille) :"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(render_grid_path.read_bytes()).decode()}},
                    {"type": "text", "text": f"{label}Image 3 (DIFFERENCE pixelmatch, rouge = ecart, meme grille) :"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(diff_grid_path.read_bytes()).decode()}},
                ]
            except Exception as page_err:
                on_progress("pass2", f"Page {i + 1} : grille/diff impossible ({page_err}) -- page ignorée dans la comparaison.")
        if not pass2_image_blocks:
            raise RuntimeError("aucune page comparable")

        if len(render_page_paths) != page_count:
            pass2_image_blocks.insert(0, {"type": "text", "text":
                f"ECART MAJEUR A CORRIGER EN PRIORITE : la cible fait {page_count} page(s), ton rendu en produit {len(render_page_paths)}. "
                f"Seules les {comparable} premiere(s) sont comparees ci-dessous. Cherche la cause (contenu qui deborde, page fixe en trop, section absente) avant tout autre ajustement."})
        on_progress("pass2", "Diff pixelmatch : " + ", ".join(f"page {i + 1} {r * 100:.1f}%" for i, r in enumerate(ratios)) + " de pixels différents.")
    except Exception as err:
        on_progress("pass2", f"Grille/diff indisponible ({err}) -- repli sur l'envoi simple des 2 images.")
        pass2_image_blocks = [
            *target_image_blocks,
            {"type": "text", "text": "^ Image(s) 1 (CIBLE)."},
            {"type": "text", "text": "Image 2 (TON RENDU ACTUEL, toutes pages empilees) :"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(png1_path.read_bytes()).decode()}},
        ]

    pass2_prompt = (read_prompt_template("pass2.md")
                     .replace("{{PAGE_SCOPE}}", page_scope_text)
                     .replace("{{JSX}}", jsx1)
                     .replace("{{DICTIONARY}}", dictionary_compact)
                     .replace("{{CANVAS_SIZE}}", f"{width} x {height}"))
    jsx2_raw = client.call("pass2", [*pass2_image_blocks, {"type": "text", "text": pass2_prompt}], effort="high")
    jsx2 = fix_double_assets_prefix(ensure_root_max_width(extract_code(jsx2_raw)))
    assert_valid_jsx(jsx2, "2")
    jsx2_path = out_dir / "attempt2.jsx"
    jsx2_path.write_text(jsx2, encoding="utf-8")
    crop_extra_images(jsx2_raw, target_paths, out_dir, python_bin)
    save_assets_map(jsx2_raw, out_dir)
    place_extracted_images(jsx2, out_dir)
    png2_path = out_dir / "attempt2.png"
    on_progress("pass2", "Rendu de la tentative 2...")
    render(jsx2_path, png2_path)
    passes.append({"name": "pass2", "label": "Passe 2 -- diff visuel", "jsx_path": jsx2_path, "png_path": png2_path,
                    "html_path": png2_path.with_suffix(".html")})
    on_progress("pass2", "OK")

    # --- Passe 3 : audit de câblage ---
    # Un controle algorithmique passe d'abord : s'il ne trouve rien, la
    # passe modele est purement et simplement sautee.
    findings = audit_jsx(jsx2)
    jsx3_path = out_dir / "attempt3.jsx"
    png3_path = out_dir / "attempt3.png"
    jsx3 = jsx2

    if not findings:
        on_progress("pass3", "Contrôle automatique : aucun problème de câblage -- passe modèle évitée.")
        jsx3_path.write_bytes(jsx2_path.read_bytes())
        png3_path.write_bytes(png2_path.read_bytes())
        html2 = png2_path.with_suffix(".html")
        if html2.exists():
            png3_path.with_suffix(".html").write_bytes(html2.read_bytes())
    else:
        on_progress("pass3", f"Contrôle automatique : {len(findings)} point(s) à corriger -- {', '.join(f['rule'] for f in findings)}")
        pass3_prompt = (read_prompt_template("pass3.md")
                         .replace("{{JSX}}", jsx2)
                         .replace("{{FINDINGS}}", "\n".join(f"{i + 1}. [{f['rule']}] {f['message']}" for i, f in enumerate(findings))))
        jsx3_raw = client.call("pass3", [{"type": "text", "text": pass3_prompt}], effort="low")
        jsx3 = fix_double_assets_prefix(ensure_root_max_width(extract_code(jsx3_raw)))
        assert_valid_jsx(jsx3, "3")
        jsx3_path.write_text(jsx3, encoding="utf-8")
        place_extracted_images(jsx3, out_dir)
        on_progress("pass3", "Rendu de la tentative 3...")
        render(jsx3_path, png3_path)
    passes.append({"name": "pass3", "label": "Passe 3 -- audit", "jsx_path": jsx3_path, "png_path": png3_path,
                    "html_path": png3_path.with_suffix(".html")})
    on_progress("pass3", "OK")

    # --- Passe 4 : correction d'échelle ALGORITHMIQUE (aucun appel modèle) ---
    on_progress("scale-fix", "Mesure des tailles réelles (dictionnaire vs. rendu)...")
    final_path, final_png_path = jsx3_path, png3_path
    scale_note = "aucune correction necessaire"
    try:
        dict_result = subprocess.run([python_bin, str(MEASURE_DICTIONARY_PY), str(dictionary_path)], capture_output=True, text=True)
        dict_sizes = json.loads(dict_result.stdout or "{}") if dict_result.returncode == 0 else {}
        headings = list(dict_sizes.keys())

        if len(headings) >= 2:
            dom_sizes = measure_dom_sizes(png3_path.with_suffix(".html"), headings, width, height)
            ratios = sorted(dict_sizes[h] / dom_sizes[h] for h in headings if dom_sizes.get(h, 0) > 0)

            if len(ratios) >= 2:
                median = ratios[len(ratios) // 2]
                on_progress("scale-fix", f"Ratio mesuré: {median:.3f} (sur {len(ratios)} titres comparés)")

                if abs(median - 1) > 0.08:
                    root_font_re = re.compile(
                        r"(fontSize:\s*containerWidth\s*\?\s*`\$\{\(containerWidth\s*\*\s*\()([\d.]+)"
                        r"(\s*/\s*CANVAS_W\)\)[^}]*\}px`\s*:\s*')([\d.]+)(px')"
                    )
                    match = root_font_re.search(jsx3)
                    if match:
                        old_value = float(match.group(2))
                        new_value = f"{old_value * median:.2f}"
                        jsx4 = root_font_re.sub(lambda m: f"{m.group(1)}{new_value}{m.group(3)}{new_value}{m.group(5)}", jsx3)
                        final_path = out_dir / "final.jsx"
                        final_path.write_text(jsx4, encoding="utf-8")
                        place_extracted_images(jsx4, out_dir)
                        final_png_path = out_dir / "final.png"
                        render(final_path, final_png_path)
                        scale_note = f"police racine corrigee de {old_value} a {new_value} (x{median:.3f})"
                    else:
                        scale_note = f"écart de {median:.3f} détecté mais le motif fontSize attendu n'a pas été trouvé dans le JSX -- pas de correction appliquee"
            else:
                scale_note = "pas assez de titres correspondants trouves pour mesurer un ratio fiable"
        else:
            scale_note = "pas assez de titres statiques détectés dans le dictionnaire"
    except Exception as err:
        scale_note = f"mesure échouée ({err}) -- pas de correction appliquée"
    on_progress("scale-fix", scale_note)
    passes.append({"name": "final", "label": "Passe 4 -- correction d'échelle", "jsx_path": final_path, "png_path": final_png_path,
                    "html_path": final_png_path.with_suffix(".html")})

    # --- Passe 5 : correction de tailles PAR ÉLÉMENT, ALGORITHMIQUE ---
    on_progress("size-fix", "Mesure des tailles par élément (images + libellés statiques)...")
    size_fix_note = "aucune correction necessaire"
    try:
        jsx_current = final_path.read_text(encoding="utf-8")
        changed = False
        notes = []

        # --- Composant 0 : securite de debordement de texte ---
        safety = add_text_safety(jsx_current)
        if safety["count"] > 0:
            jsx_current = safety["jsx"]
            changed = True
            notes.append(f"débordement texte : max-w-full/break-words ajoutés sur {safety['count']} éléments")

        root_font_match = re.search(r"fontSize:\s*containerWidth\s*\?\s*`\$\{\(containerWidth\s*\*\s*\(([\d.]+)\s*/\s*CANVAS_W\)\)", jsx_current)
        root_font_px = float(root_font_match.group(1)) if root_font_match else None

        # --- Composant A : tailles d'images (dimensions natives = vérité terrain) ---
        # Vrai UNIQUEMENT pour les images EXTRA_IMAGES (indices > lot initial
        # pdfimages) : elles sont découpées à la même échelle/DPI que la cible.
        if root_font_px:
            import_re = re.compile(r"import\s+(\w+)\s+from\s+['\"]@/images/cv-templates/[a-zA-Z0-9_-]+/extracted-(\d+)\.(?:png|jpe?g)['\"]")
            for var_name, index in import_re.findall(jsx_current):
                if int(index) <= len(extracted_images):
                    continue
                img_path = out_dir / f"extracted-{index}.png"
                if not img_path.exists():
                    continue
                native_w, native_h = png_size(img_path)
                img_tag_re = re.compile(rf'<img\s[^>]*src=\{{{re.escape(var_name)}\}}[^>]*className="([^"]*)"[^>]*/?>')

                def _fix_img(m):
                    nonlocal changed
                    full_tag, class_str = m.group(0), m.group(1)
                    if "rotate-[" in class_str:
                        return full_tag
                    local_changed = False
                    def _fix_dim(dm):
                        nonlocal local_changed
                        sp, dim, old_em_str = dm.group(1), dm.group(2), dm.group(3)
                        native_px = native_h if dim == "h" else native_w
                        correct_em = native_px / root_font_px
                        old_em = float(old_em_str)
                        if abs(correct_em - old_em) / correct_em > 0.2:
                            notes.append(f"image {var_name}: {dim}-[{old_em}em] -> {dim}-[{correct_em:.2f}em] (natif {native_px}px)")
                            local_changed = True
                            return f"{sp}{dim}-[{correct_em:.2f}em]"
                        return dm.group(0)
                    new_class_str = re.sub(r"(^|\s)(h|w)-\[([\d.]+)em\]", _fix_dim, class_str)
                    if not local_changed:
                        return full_tag
                    changed = True
                    return full_tag.replace(class_str, new_class_str)
                jsx_current = img_tag_re.sub(_fix_img, jsx_current)

        # --- Composant B : tailles de libellés statiques, regroupées par classe partagée ---
        dict_result2 = subprocess.run([python_bin, str(COMPACT_DICTIONARY_PY), str(dictionary_path)], capture_output=True, text=True)
        dict_entries = []
        for line in (dict_result2.stdout or "").split("\n"):
            m = re.match(r"^[\d.]+,[\d.]+\|([\d.]+)px\|[^|]*\|(.*)$", line)
            if m:
                dict_entries.append((float(m.group(1)), m.group(2).strip()))
        def normalize(t: str) -> str:
            return re.sub(r"\s+", " ", t).strip().lower()
        by_text: dict[str, list[float]] = {}
        for size_px, text in dict_entries:
            key = normalize(text)
            if not key or key.startswith("{%") or key.startswith("{{"):
                continue
            by_text.setdefault(key, []).append(size_px)
        dict_size_map = {key: sorted(sizes)[len(sizes) // 2] for key, sizes in by_text.items()}

        current_html_path = final_png_path.with_suffix(".html")
        dom_texts = measure_dom_texts(current_html_path, width, height)

        groups: dict[str, list[float]] = {}
        for entry in dom_texts:
            target_size = dict_size_map.get(normalize(entry["text"]))
            if target_size is None or not (entry["fontSizePx"] > 0):
                continue
            groups.setdefault(entry["className"], []).append(target_size / entry["fontSizePx"])
        for class_name, ratios in groups.items():
            if "text-[" not in class_name or "em]" not in class_name:
                continue
            sorted_ratios = sorted(ratios)
            median = sorted_ratios[len(sorted_ratios) // 2]
            if abs(median - 1) <= 0.1:
                continue
            em_match = re.search(r"text-\[([\d.]+)em\]", class_name)
            if not em_match:
                continue
            old_em = float(em_match.group(1))
            new_em = f"{old_em * median:.2f}"
            new_class_name = re.sub(r"text-\[[\d.]+em\]", f"text-[{new_em}em]", class_name)
            if class_name in jsx_current:
                jsx_current = jsx_current.replace(class_name, new_class_name)
                notes.append(f'libelle ({len(ratios)}x) "{class_name[:40]}...": text-[{old_em}em] -> text-[{new_em}em]')
                changed = True

        if changed:
            jsx5_path = out_dir / "final.jsx"
            jsx5_path.write_text(jsx_current, encoding="utf-8")
            place_extracted_images(jsx_current, out_dir)
            png5_path = out_dir / "final.png"
            render(jsx5_path, png5_path)
            final_path, final_png_path = jsx5_path, png5_path
            size_fix_note = " | ".join(notes)
            passes[-1] = {"name": "final", "label": "Passe 4+5 -- corrections d'échelle et de tailles", "jsx_path": final_path,
                           "png_path": final_png_path, "html_path": final_png_path.with_suffix(".html")}
    except Exception as err:
        size_fix_note = f"mesure échouée ({err}) -- pas de correction appliquée"
    on_progress("size-fix", size_fix_note)
    on_progress("done", "Terminé.")

    return PipelineResult(
        out_dir=out_dir, target_path=target_path, dictionary_path=dictionary_path, width=width, height=height,
        passes=passes, per_pass_usage=client.per_pass_usage,
        total_input_tokens=client.total_input_tokens, total_output_tokens=client.total_output_tokens,
        total_cache_read_tokens=client.total_cache_read_tokens, total_cache_write_tokens=client.total_cache_write_tokens,
    )
