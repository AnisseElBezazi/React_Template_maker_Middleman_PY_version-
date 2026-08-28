import os
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile, File

from cvsmart.shared.paths_service import OUT_ROOT, UPLOADS_ROOT, ensure_roots
from cvsmart.runs.services.runs_service import register_run
from cvsmart.jinja.services.jinja_pipeline_service import run_jinja_pipeline


async def create_jinja_run(cv: UploadFile = File(...)):
    if not cv:
        raise HTTPException(status_code=400, detail="Fichier manquant.")

    ensure_roots()
    # Ce endpoint n'accepte qu'un CV .docx (cote Node, le champ "cv" force
    # toujours cette extension) -- un fallback ".pdf" ici ferait lire un
    # docx binaire comme du texte UTF-8 plus loin dans _extract_text.
    cv_path = UPLOADS_ROOT / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.docx"
    cv_path.write_bytes(await cv.read())
    pdf_url = "/uploads/" + cv_path.name

    run_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:5]}"
    out_dir = OUT_ROOT / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    state = {
        "run_id": run_id, "status": "running", "step": "extract", "message": "Démarrage...",
        "log": [], "stream": {"step": None, "kind": None, "text": ""},
        "result": None, "error": None, "pdf_url": pdf_url, "page": 1, "type": "jinja",
    }
    register_run(run_id, state)

    def on_progress(step, message):
        state["step"] = step
        state["message"] = message
        state["log"].append({"step": step, "message": message})

    api_key = os.environ.get("MOONSHOT_API_KEY") or os.environ.get("OPENAI_API_KEY")

    import threading
    import json as _json

    def worker():
        try:
            if not api_key:
                raise RuntimeError("Clé API Moonshot manquante.")
            result = run_jinja_pipeline(cv_path=cv_path, out_dir=out_dir, api_key=api_key, on_progress=on_progress)
            (out_dir / "run-meta.json").write_text(_json.dumps({
                "type": "jinja", "pdfUrl": pdf_url,
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            }, indent=2), encoding="utf-8")
            state.update({
                "status": "done", "step": "done", "message": "Terminé.",
                "result": {
                    "out_dir": str(out_dir),
                    "template_url": f"/out/{run_id}/template.docx",
                    "global_prompt_url": f"/out/{run_id}/global_prompt.md",
                    "experience_prompt_url": f"/out/{run_id}/experience_prompt.md",
                    "config_url": f"/out/{run_id}/extra_config.json",
                },
            })
        except Exception as err:
            state["status"] = "error"
            state["step"] = "error"
            state["error"] = str(err)
            state["message"] = str(err)

    threading.Thread(target=worker, daemon=True).start()
    return {"run_id": run_id}
