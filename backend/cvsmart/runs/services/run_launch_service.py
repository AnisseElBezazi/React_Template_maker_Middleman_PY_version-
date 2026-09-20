import json
import os
import threading
import time
import uuid
from pathlib import Path

from cvsmart.shared.paths_service import OUT_ROOT, to_public_url
from cvsmart.shared.errors import RunCancelled
from cvsmart.runs.services.runs_service import register_run, live_run, PASS_LABELS
from cvsmart.rendering.services.target_service import stacked_target, target_pages, png_size, PAGE_GAP
from cvsmart.pipeline.services.pipeline_service import run_pipeline
from cvsmart.pipeline.services.model_client_service import IS_MOONSHOT, RATE

STAGES = [
    {"id": "extract", "name": "Extraction"},
    {"id": "pass1", "name": "Passe 1"},
    {"id": "pass2", "name": "Passe 2"},
    {"id": "pass3", "name": "Passe 3"},
    {"id": "scale-fix", "name": "Correction d'echelle"},
    {"id": "size-fix", "name": "Correction de tailles"},
    {"id": "done", "name": "Termine"},
]


def _api_key() -> str | None:
    return os.environ.get("MOONSHOT_API_KEY") if IS_MOONSHOT else os.environ.get("ANTHROPIC_API_KEY")


def start_run(pdf_path: Path, page: str, effort: str, extra_config_path: Path | None, pdf_url: str,
              source_name: str | None = None, has_cover_page: bool = False) -> str:
    run_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:5]}"
    out_dir = OUT_ROOT / run_id

    state = {
        "run_id": run_id, "type": "jsx", "status": "running", "step": "extract", "message": "Demarrage...",
        "log": [], "stream": {"step": None, "kind": None, "text": ""},
        "result": None, "error": None, "pdf_url": pdf_url, "target_url": None,
        "page": page, "effort": effort, "cancel_requested": False, "source_name": source_name,
        "has_cover_page": has_cover_page,
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

    api_key = _api_key()

    def worker():
        try:
            if not api_key:
                raise RuntimeError("Clé API manquante. Configure MOONSHOT_API_KEY (ou ANTHROPIC_API_KEY) dans backend/.env.")
            result = run_pipeline(
                pdf_path=pdf_path, out_dir=out_dir, api_key=api_key, page_number=page, pass1_effort=effort,
                extra_config_path=extra_config_path, on_progress=on_progress, on_stream=on_stream,
                should_cancel=should_cancel, has_cover_page=has_cover_page,
            )
            passes = [{
                "name": p["name"], "label": p["label"],
                "png_url": to_public_url(p["png_path"]),
                "html_url": to_public_url(p["html_path"]) if p["html_path"].exists() else None,
            } for p in result.passes]

            target_page_heights = [size[1] for tp in target_pages(out_dir) if (size := png_size(tp))]
            final_name = result.passes[-1]["name"]
            preview_page_heights = []
            idx = 1
            while True:
                page_png = out_dir / f"{final_name}-page-{idx}.png"
                if not page_png.exists():
                    break
                size = png_size(page_png)
                if not size:
                    break
                preview_page_heights.append(size[1])
                idx += 1

            def stack_height(heights):
                return sum(heights) + PAGE_GAP * (len(heights) - 1) if heights else result.height

            target_height = stack_height(target_page_heights)
            preview_height = stack_height(preview_page_heights)

            stacked = stacked_target(out_dir)
            cost_usd = round(sum(p.cost_usd for p in result.per_pass_usage), 4)

            per_pass_meta = [{
                "step": p.step, "effort": p.effort, "inputTokens": p.input_tokens, "outputTokens": p.output_tokens,
                "cacheReadTokens": p.cache_read_tokens, "cacheWriteTokens": p.cache_write_tokens, "costUsd": p.cost_usd,
            } for p in result.per_pass_usage]
            (out_dir / "run-meta.json").write_text(json.dumps({
                "pdfUrl": pdf_url, "sourceName": source_name, "page": page, "effort": effort,
                "width": result.width, "height": result.height,
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                "tokens": {
                    "totalInputTokens": result.total_input_tokens, "totalOutputTokens": result.total_output_tokens,
                    "totalCacheReadTokens": result.total_cache_read_tokens, "totalCacheWriteTokens": result.total_cache_write_tokens,
                },
                "perPass": per_pass_meta, "costUsd": cost_usd,
            }, indent=2), encoding="utf-8")

            state.update({
                "status": "done", "step": "done", "message": "Termine.",
                "target_url": to_public_url(stacked) if stacked else None,
                "cost_usd": cost_usd,
                "result": {
                    "out_dir": str(out_dir), "width": result.width, "height": result.height,
                    "page_count": len(target_pages(out_dir)),
                    "target_height": target_height, "preview_height": preview_height,
                    "world_height": max(target_height, preview_height),
                    "target_page_heights": target_page_heights, "preview_page_heights": preview_page_heights,
                    "passes": passes,
                    "total_input_tokens": result.total_input_tokens, "total_output_tokens": result.total_output_tokens,
                    "total_cache_read_tokens": result.total_cache_read_tokens,
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
    return run_id
