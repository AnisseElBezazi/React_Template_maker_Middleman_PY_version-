import json
from pathlib import Path

from fastapi import HTTPException, UploadFile, Form, File

from cvsmart.runs.services import runs_service
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


async def create_run(
    pdf: UploadFile = File(...),
    page: str = Form("all"),
    effort: str = Form("high"),
    extra_config: UploadFile | None = File(None),
    extra_config_text: str | None = Form(None),
):
    pdf_path = _save_upload(pdf, ".pdf")
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

    run_id = start_run(pdf_path, page_value, effort_value, extra_config_path, pdf_url)
    return {"run_id": run_id}


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
