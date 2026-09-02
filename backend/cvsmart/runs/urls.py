from fastapi import APIRouter

from cvsmart.runs.controllers import runs_controller

router = APIRouter(prefix="/api/runs", tags=["runs"])

router.add_api_route("", runs_controller.get_runs, methods=["GET"])
router.add_api_route("", runs_controller.create_run, methods=["POST"])
router.add_api_route("/{run_id}", runs_controller.get_run, methods=["GET"])
router.add_api_route("/{run_id}/status", runs_controller.get_run_status, methods=["GET"])
router.add_api_route("/{run_id}/cancel", runs_controller.cancel_run, methods=["POST"])
