from fastapi import APIRouter

from cvsmart.jinja.controllers.jinja_controller import create_jinja_run

router = APIRouter(prefix="/api/jinja-runs", tags=["jinja"])
router.add_api_route("", create_jinja_run, methods=["POST"])
