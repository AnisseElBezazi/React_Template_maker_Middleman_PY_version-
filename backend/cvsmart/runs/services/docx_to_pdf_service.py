import os
import shutil
import subprocess
import tempfile
from pathlib import Path

CONVERSION_TIMEOUT_SECONDS = 180

# `soffice` n'est pas toujours dans le PATH du process uvicorn (surtout sous
# macOS, ou LibreOffice.app n'ajoute rien au PATH) : on teste aussi les
# emplacements d'installation habituels.
SOFFICE_FALLBACKS = (
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


def _find_soffice() -> str | None:
    env_path = os.environ.get("SOFFICE_PATH")
    if env_path and Path(env_path).exists():
        return env_path
    found = shutil.which("soffice")
    if found:
        return found
    return next((p for p in SOFFICE_FALLBACKS if Path(p).exists()), None)


def is_docx_filename(filename: str | None) -> bool:
    return bool(filename) and filename.lower().endswith(".docx")


def convert_docx_to_pdf(docx_path: Path) -> Path:
    """Convertit un .docx en .pdf (meme dossier, meme nom) avec LibreOffice
    en mode headless. Un profil LibreOffice temporaire est utilise a chaque
    appel : sans lui, la conversion echoue silencieusement des que
    LibreOffice est deja ouvert sur la machine (verrou sur le profil
    utilisateur)."""
    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError(
            "LibreOffice est introuvable : installe-le (brew install --cask libreoffice) "
            "ou renseigne SOFFICE_PATH dans backend/.env pour convertir un .docx en PDF."
        )

    pdf_path = docx_path.with_suffix(".pdf")
    with tempfile.TemporaryDirectory() as profile_dir:
        try:
            proc = subprocess.run(
                [
                    soffice, f"-env:UserInstallation=file://{profile_dir}",
                    "--headless", "--convert-to", "pdf", "--outdir", str(docx_path.parent), str(docx_path),
                ],
                capture_output=True, text=True, timeout=CONVERSION_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"La conversion du .docx en PDF a depasse {CONVERSION_TIMEOUT_SECONDS}s.")

    if proc.returncode != 0 or not pdf_path.exists():
        detail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise RuntimeError(f"La conversion du .docx en PDF a echoue. {detail}".strip())
    return pdf_path
