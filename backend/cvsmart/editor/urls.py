from fastapi import APIRouter

from cvsmart.editor.controllers.editor_controller import rerender_run, editor_overlay, apply_edits, chat_edit

router = APIRouter(tags=["editor"])
router.add_api_route("/api/runs/{run_id}/rerender", rerender_run, methods=["POST"])
router.add_api_route("/editor-overlay.js", editor_overlay, methods=["GET"])
router.add_api_route("/api/runs/{run_id}/image-edits", apply_edits, methods=["POST"])
router.add_api_route("/api/runs/{run_id}/chat", chat_edit, methods=["POST"])
