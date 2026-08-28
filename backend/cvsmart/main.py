from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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

app.mount("/out", StaticFiles(directory=OUT_ROOT), name="out")
app.mount("/uploads", StaticFiles(directory=UPLOADS_ROOT), name="uploads")


@app.get("/api/health")
def health():
    return {"status": "ok"}
