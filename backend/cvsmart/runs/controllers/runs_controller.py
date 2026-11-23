import json
from pathlib import Path

from fastapi import HTTPException, UploadFile, Form, File
from fastapi.concurrency import run_in_threadpool

from cvsmart.runs.services import runs_service
from cvsmart.runs.services.docx_to_pdf_service import convert_docx_to_pdf, is_docx_filename
from cvsmart.runs.services.run_launch_service import start_run
from cvsmart.shared.paths_service import UPLOADS_ROOT, ensure_roots


def get_runs():
    return {"runs": runs_service.list_runs()}


def _save_upload(upload: UploadFile, suffix: str) -> Path:
    ensure_roots()
    import time, uuid
    dest = UPLOADS_ROOT / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}{suffix}"
    dest.write_bytes(upload.file.read())
    return dest


def _ensure_valid_pdf(path: Path):
    """Le champ d'upload de l'éditeur visuel n'accepte QUE des PDF cote front
    (accept="application/pdf"), mais un glisser-déposer ou un selecteur
    systeme peut laisser passer un autre format malgre tout. Confirme sur
    un cas reel : un .docx envoye ici a ete sauvegarde tel quel sous
    l'extension .pdf par _save_upload (qui ne verifie jamais le contenu),
    puis a fait planter pdfinfo bien plus loin dans extract.py avec un
    message incomprehensible ("Impossible de lire le nombre de pages du
    PDF"), sans aucune indication que le fichier envoye n'etait pas un PDF.
    Verifie la signature PDF ("%PDF-") des l'upload pour echouer tout de
    suite avec un message clair au lieu de laisser l'erreur remonter,
    cryptique, depuis le pipeline."""
    header = path.read_bytes()[:1024]
    if b"%PDF-" not in header:
        path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail="Le fichier envoyé n'est pas un PDF valide (vérifie que tu as bien sélectionné un .pdf, pas un .docx ou un autre format).",
        )


async def create_run(
    pdf: UploadFile = File(...),
    page: str = Form("all"),
    effort: str = Form("high"),
    extra_config: UploadFile | None = File(None),
    extra_config_text: str | None = Form(None),
    has_cover_page: str = Form("false"),
):
    if is_docx_filename(pdf.filename):
        docx_path = _save_upload(pdf, ".docx")
        try:
            pdf_path = await run_in_threadpool(convert_docx_to_pdf, docx_path)
        except RuntimeError as err:
            raise HTTPException(status_code=500, detail=str(err))
    else:
        pdf_path = _save_upload(pdf, ".pdf")
    _ensure_valid_pdf(pdf_path)
    pdf_url = "/uploads/" + pdf_path.name

    extra_config_path = None
    if extra_config is not None:
        extra_config_path = _save_upload(extra_config, ".json")
    elif extra_config_text and extra_config_text.strip():
        try:
            json.loads(extra_config_text)
        except json.JSONDecodeError as err:
            raise HTTPException(status_code=400, detail=f"extra_config colle n'est pas un JSON valide : {err}")
        ensure_roots()
        import time, uuid
        extra_config_path = UPLOADS_ROOT / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
        extra_config_path.write_text(extra_config_text, encoding="utf-8")

    rawpage = (page or "all").strip().lower()
    page_value = "all" if rawpage == "all" else str(int(rawpage)) if rawpage.isdigit() else "all"
    effort_value = effort if effort in ("low", "high", "max") else "high"

    source_name = runs_service.clean_source_name(pdf.filename)
    has_cover_page_value = (has_cover_page or "false").strip().lower() in ("true", "1", "on", "yes")
    run_id = start_run(pdf_path, page_value, effort_value, extra_config_path, pdf_url, source_name, has_cover_page_value)
    return {"run_id": run_id}


def cancel_run(run_id: str):
    """Marche pour un run PDF comme pour un run Jinja : les deux partagent le
    meme registre de runs en memoire (register_run)."""
    if not runs_service.request_cancel(run_id):
        raise HTTPException(status_code=409, detail="Run introuvable ou déjà terminé.")
    return {"ok": True}


def get_run(run_id: str):
    state = runs_service.get_run(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run introuvable.")
    return state


def get_run_status(run_id: str):
    """Version legere, interrogee en boucle pendant un run : le front n'a pas
    besoin de recharger passes et metriques a chaque tick."""
    state = runs_service.get_run(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run introuvable.")
    return {
        "run_id": run_id,
        "status": state["status"],
        "step": state["step"],
        "message": state["message"],
        "log": state.get("log", []),
        "error": state.get("error"),
        "stream": state.get("stream"),
    }
