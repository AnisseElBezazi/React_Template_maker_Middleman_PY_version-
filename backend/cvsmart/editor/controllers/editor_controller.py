from pathlib import Path

from fastapi import Body, HTTPException
from fastapi.responses import FileResponse

from cvsmart.runs.services.runs_service import get_run
from cvsmart.jsx.services.image_edits_service import apply_image_edits, apply_text_edits, apply_class_edits
from cvsmart.shared.paths_service import NODE_TOOLS_ROOT
from cvsmart.editor.services.editor_service import cv_data_for_run, rerender_final_pass


def _final_pass_paths(state: dict) -> tuple[Path, Path]:
    out_dir = Path(state["result"]["out_dir"])
    final_name = state["result"]["passes"][-1]["name"]
    return out_dir / f"{final_name}.jsx", out_dir / f"{final_name}.png"


def rerender_run(run_id: str):
    state = get_run(run_id)
    if not state or state.get("status") != "done":
        raise HTTPException(status_code=404, detail="Run introuvable ou pas terminé.")
    out_dir = Path(state["result"]["out_dir"])
    jsx_path, png_path = _final_pass_paths(state)
    result = rerender_final_pass(out_dir, jsx_path, png_path, state["result"]["width"], state["result"]["height"])
    if result["errors"]:
        raise HTTPException(status_code=500, detail=f"Rendu échoué: {result['errors']}")
    return {"ok": True}


def editor_overlay():
    # Jamais de cache : ce script evolue souvent, une version perimee servie
    # depuis le cache du navigateur donne un editeur qui "ne marche pas"
    # alors que le correctif est bien sur le disque.
    path = NODE_TOOLS_ROOT / "src" / "public" / "editor_overlay.js"
    return FileResponse(path, media_type="application/javascript",
                         headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


def apply_edits(run_id: str, body: dict = Body(...)):
    # def SYNCHRONE (pas async) : Playwright tourne en API sync et refuse de
    # s'executer si la boucle asyncio de FastAPI est active sur ce thread --
    # une route sync est dispatchee par FastAPI dans un thread a part, ce qui
    # evite le conflit. C'est deja pourquoi rerender_run fonctionne.
    state = get_run(run_id)
    if not state or state.get("status") != "done":
        raise HTTPException(status_code=404, detail="Run introuvable ou pas terminé.")
    edits = body.get("edits") or {}
    text_edits = body.get("textEdits") or {}
    class_edits = body.get("classEdits") or {}
    if not edits and not text_edits and not class_edits:
        raise HTTPException(status_code=400, detail="Aucun ajustement reçu.")

    out_dir = Path(state["result"]["out_dir"])
    jsx_path, png_path = _final_pass_paths(state)
    try:
        source = jsx_path.read_text(encoding="utf-8")
        img_pass = apply_image_edits(source, edits)
        text_pass = apply_text_edits(img_pass["source"], text_edits)
        class_pass = apply_class_edits(text_pass["source"], class_edits)
        applied = [*img_pass["applied"], *text_pass["applied"], *class_pass["applied"]]
        if not applied:
            raise HTTPException(status_code=400, detail="Aucune balise correspondante trouvée dans le JSX.")
        jsx_path.write_text(class_pass["source"], encoding="utf-8")

        result = rerender_final_pass(out_dir, jsx_path, png_path, state["result"]["width"], state["result"]["height"])
        if result["errors"]:
            raise HTTPException(status_code=500, detail=f"Rendu échoué: {result['errors']}")
        return {"ok": True, "applied": applied}
    except HTTPException:
        raise
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err))
