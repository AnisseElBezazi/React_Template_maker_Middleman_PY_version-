from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


class NoCacheStaticFiles(StaticFiles):
    """Les fichiers sous /out (html/png d'un run) sont réécrits EN PLACE au
    même chemin par rerender/apply-edits/chat-edit -- un navigateur qui les a
    déjà mis en cache (StaticFiles ne pose aucun Cache-Control par défaut,
    donc soumis à l'heuristique de fraîcheur du navigateur) continue de
    montrer l'ancienne version après une modification, exactement le bug déjà
    corrigé pour editor_overlay.js."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        return response

from cvsmart.shared.paths_service import BACKEND_ROOT, PROJECT_ROOT, NODE_TOOLS_ROOT, OUT_ROOT, UPLOADS_ROOT, ensure_roots
from cvsmart.runs.urls import router as runs_router
from cvsmart.download.urls import router as download_router
from cvsmart.editor.urls import router as editor_router
from cvsmart.jinja.urls import router as jinja_router

# Meme cle utilisable depuis les trois emplacements historiques : la cle
# vecue jusqu'ici dans pipeline/.env (Node) reste valable sans copie.
load_dotenv(BACKEND_ROOT / ".env")
load_dotenv(NODE_TOOLS_ROOT / ".env")
load_dotenv(PROJECT_ROOT / ".env")

ensure_roots()

app = FastAPI(title="CV Smart Design-to-Code", version="0.1.0")

# Le front React tourne sur son propre port en developpement (Vite).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(runs_router)
app.include_router(download_router)
app.include_router(editor_router)
app.include_router(jinja_router)

app.mount("/out", NoCacheStaticFiles(directory=OUT_ROOT), name="out")
app.mount("/uploads", StaticFiles(directory=UPLOADS_ROOT), name="uploads")


@app.get("/api/health")
def health():
    return {"status": "ok"}
