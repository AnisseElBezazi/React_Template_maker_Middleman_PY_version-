import base64
from pathlib import Path
from typing import Callable

from cvsmart.pipeline.services.model_client_service import ModelClient
from cvsmart.pipeline.services.prompt_helpers import read_prompt_template, extract_code, assert_valid_jsx
from cvsmart.pipeline.services.jsx_artifacts_service import place_extracted_images
from cvsmart.jsx.services.audit_service import audit_jsx
from cvsmart.rendering.services.render_service import render as render_component
from cvsmart.rendering.services.target_service import stacked_target
from cvsmart.editor.services.editor_service import cv_data_for_run


CHAT_EDIT_PROMPT = "chat_edit.md"


def _image_block(path: Path) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.b64encode(path.read_bytes()).decode()}}


def apply_chat_edit(
    out_dir: Path, jsx_path: Path, png_path: Path, width: int, height: int,
    api_key: str, message: str,
    on_progress: Callable[[str, str], None] = lambda step, msg: None,
    on_stream: Callable[[str, str, str], None] = lambda step, kind, text: None,
) -> dict:
    """Modification ciblee du composant deja genere, pilotee par une demande
    en langage naturel -- pensee comme une correction rapide (effort "low") :
    le JSX actuel est deja bon dans l'ensemble, on ne veut QUE le changement
    demande, vite. Le prompt lean (chat_edit.md, pas les ~100 lignes de
    pass1.md) rend une violation des conventions CV Smart reelles (data-
    block-id, cvData?., saleInfo...) plus probable qu'a la generation
    initiale, pas moins -- donc le meme controle MECANIQUE et GRATUIT que la
    passe 3 (audit_jsx) tourne systematiquement apres coup, et une seule
    repasse ciblee (meme prompt pass3.md, low effort) corrige si besoin
    AVANT d'ecrire le resultat sur le disque. Skippee (donc gratuite) des
    que rien n'est detecte, comme en passe 3."""
    jsx_current = jsx_path.read_text(encoding="utf-8")
    # Meme schema que la generation initiale (pass1) : le JSX seul ne montre
    # que les champs DEJA affiches -- une demande portant sur une donnee pas
    # encore utilisee (ex: "affiche aussi le telephone") ferait sinon
    # inventer un nom de champ plausible mais faux, exactement le genre de
    # "champ-invente" que l'audit plus bas ne peut pas toujours rattraper.
    cvdata_schema = cv_data_for_run(out_dir).read_text(encoding="utf-8")

    prompt = (read_prompt_template(CHAT_EDIT_PROMPT)
              .replace("{{JSX}}", jsx_current)
              .replace("{{CVDATA_SCHEMA}}", cvdata_schema)
              .replace("{{REQUEST}}", message))

    # Une demande visuelle ("le logo est trop petit", "aligne comme sur le
    # PDF") est illisible sans les images : le JSX seul ne dit pas a quoi
    # ca ressemble EN VRAI. Meme logique que la passe 2 (cible + rendu
    # actuel), mais sans grille/diff -- ca ajouterait un traitement
    # supplementaire pour un gain de precision inutile sur une retouche
    # ciblee, alors que la vitesse est le but ici.
    content = [{"type": "text", "text": prompt}]
    target_path = stacked_target(out_dir)
    if target_path and target_path.exists():
        content.append({"type": "text", "text": "Image CIBLE (design PDF d'origine à reproduire) :"})
        content.append(_image_block(target_path))
    if png_path.exists():
        content.append({"type": "text", "text": "TON RENDU ACTUEL de ce composant, AVANT la modification demandée :"})
        content.append(_image_block(png_path))

    client = ModelClient(api_key=api_key, on_progress=on_progress, on_stream=on_stream)
    raw = client.call("chat-edit", content, max_tokens=16000, effort="low")

    jsx_new = extract_code(raw)
    assert_valid_jsx(jsx_new, "chat-edit")

    findings = audit_jsx(jsx_new)
    if findings:
        on_progress("chat-edit", f"Contrôle automatique : {len(findings)} point(s) à corriger -- {', '.join(f['rule'] for f in findings)}")
        pass3_prompt = (read_prompt_template("pass3.md")
                         .replace("{{JSX}}", jsx_new)
                         .replace("{{FINDINGS}}", "\n".join(f"{i + 1}. [{f['rule']}] {f['message']}" for i, f in enumerate(findings))))
        fixed_raw = client.call("chat-edit-audit", [{"type": "text", "text": pass3_prompt}], max_tokens=16000, effort="low")
        jsx_new = extract_code(fixed_raw)
        assert_valid_jsx(jsx_new, "chat-edit-audit")

    place_extracted_images(jsx_new, out_dir)
    jsx_path.write_text(jsx_new, encoding="utf-8")

    cv_data_path = cv_data_for_run(out_dir)
    result = render_component(jsx_path, cv_data_path, png_path, width, height)
    if result["errors"]:
        raise RuntimeError(f"Rendu échoué après modification : {result['errors']}")

    return {
        "cost_usd": round(sum(p.cost_usd for p in client.per_pass_usage), 4),
        "audit_findings": [f["rule"] for f in findings],
    }
