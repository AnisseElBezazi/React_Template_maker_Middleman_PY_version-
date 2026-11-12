import os
import time
import uuid
from pathlib import Path

from fastapi import Form, HTTPException, UploadFile, File

from cvsmart.shared.paths_service import OUT_ROOT, UPLOADS_ROOT, ensure_roots
from cvsmart.shared.errors import RunCancelled
from cvsmart.runs.services.runs_service import register_run, clean_source_name
from cvsmart.jinja.services.jinja_pipeline_service import run_jinja_pipeline


async def create_jinja_run(cv: UploadFile = File(...), effort: str = Form("high")):
    if not cv:
        raise HTTPException(status_code=400, detail="Fichier manquant.")
    effort_value = effort if effort in ("low", "high", "max") else "high"

    ensure_roots()
    # Ce endpoint n'accepte qu'un CV .docx (cote Node, le champ "cv" force
    # toujours cette extension) -- un fallback ".pdf" ici ferait lire un
    # docx binaire comme du texte UTF-8 plus loin dans _extract_text.
    cv_path = UPLOADS_ROOT / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.docx"
    cv_path.write_bytes(await cv.read())
    pdf_url = "/uploads/" + cv_path.name
    source_name = clean_source_name(cv.filename)

    run_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:5]}"
    out_dir = OUT_ROOT / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    state = {
        "run_id": run_id, "status": "running", "step": "extract", "message": "Démarrage...",
        "log": [], "stream": {"step": None, "kind": None, "text": ""},
        "result": None, "error": None, "pdf_url": pdf_url, "page": 1, "type": "jinja",
        "cancel_requested": False, "source_name": source_name, "effort": effort_value,
    }
    register_run(run_id, state)

    def on_progress(step, message):
        state["step"] = step
        state["message"] = message
        state["log"].append({"step": step, "message": message})

    def on_stream(step, kind, text):
        state["stream"] = {"step": step, "kind": kind, "text": text}

    def should_cancel():
        return state.get("cancel_requested", False)

    api_key = os.environ.get("MOONSHOT_API_KEY") or os.environ.get("OPENAI_API_KEY")

    import threading
    import json as _json

    def worker():
        try:
            if not api_key:
                raise RuntimeError("Clé API Moonshot manquante.")
            result = run_jinja_pipeline(
                cv_path=cv_path, out_dir=out_dir, api_key=api_key,
                on_progress=on_progress, on_stream=on_stream, should_cancel=should_cancel,
                effort=effort_value,
            )
            per_pass_meta = [{
                "step": p.step, "effort": p.effort, "inputTokens": p.input_tokens, "outputTokens": p.output_tokens,
                "cacheReadTokens": p.cache_read_tokens, "cacheWriteTokens": p.cache_write_tokens, "costUsd": p.cost_usd,
            } for p in result.per_pass_usage]
            (out_dir / "run-meta.json").write_text(_json.dumps({
                "type": "jinja", "pdfUrl": pdf_url, "sourceName": source_name, "effort": effort_value,
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                "tokens": {
                    "totalInputTokens": result.total_input_tokens, "totalOutputTokens": result.total_output_tokens,
                    "totalCacheReadTokens": result.total_cache_read_tokens,
                },
                "perPass": per_pass_meta, "costUsd": result.cost_usd,
                "sourcePageCount": result.source_page_count, "templatePageCount": result.template_page_count,
            }, indent=2), encoding="utf-8")
            state.update({
                "status": "done", "step": "done", "message": "Terminé.",
                "cost_usd": result.cost_usd,
                "result": {
                    "out_dir": str(out_dir),
                    "template_url": f"/out/{run_id}/template.docx",
                    "global_prompt_url": f"/out/{run_id}/global_prompt.md",
                    "experience_prompt_url": f"/out/{run_id}/experience_prompt.md",
                    "config_url": f"/out/{run_id}/extra_config.json",
                    "total_input_tokens": result.total_input_tokens, "total_output_tokens": result.total_output_tokens,
                    "total_cache_read_tokens": result.total_cache_read_tokens,
                    "source_page_count": result.source_page_count, "template_page_count": result.template_page_count,
                },
            })
        except RunCancelled:
            state["status"] = "cancelled"
            state["step"] = "cancelled"
            state["message"] = "Annulé."
        except Exception as err:
            state["status"] = "error"
            state["step"] = "error"
            state["error"] = str(err)
            state["message"] = str(err)

    threading.Thread(target=worker, daemon=True).start()
    return {"run_id": run_id}
