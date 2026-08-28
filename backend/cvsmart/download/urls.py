from fastapi import APIRouter

from cvsmart.download.controllers.download_controller import download_run

router = APIRouter(prefix="/api/runs", tags=["download"])
router.add_api_route("/{run_id}/download", download_run, methods=["GET"])
