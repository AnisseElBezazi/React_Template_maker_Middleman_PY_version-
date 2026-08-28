import subprocess
import time
import os
import random
from pathlib import Path

from cvsmart.shared.paths_service import NODE_TOOLS_ROOT, OUT_ROOT

TAILWIND_BIN = NODE_TOOLS_ROOT / "node_modules" / ".bin" / "tailwindcss"
TAILWIND_DIR = NODE_TOOLS_ROOT / "src" / "tailwind"


def compile_tailwind(content_globs: str, input_css: Path, config_path: Path | None = None,
                     minify: bool = True) -> tuple[str, str | None]:
    """Compile Tailwind et renvoie (css, erreur).

    Chemin de sortie UNIQUE par compilation : plusieurs rendus peuvent tourner
    en parallele (traitement par lots). Avec un fichier partage, l'un lisait le
    CSS pendant que l'autre le reecrivait -- classes manquantes et mises en
    page cassees de facon intermittente.
    """
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    suffix = f"{os.getpid()}-{int(time.time() * 1000)}-{random.randint(10000, 99999)}"
    out_css = OUT_ROOT / f".tailwind-{suffix}.css"

    args = [str(TAILWIND_BIN), "-i", str(input_css), "-o", str(out_css), "--content", content_globs]
    if config_path:
        args += ["-c", str(config_path)]
    if minify:
        args.append("--minify")

    try:
        result = subprocess.run(args, capture_output=True, text=True, cwd=str(NODE_TOOLS_ROOT))
        if result.returncode != 0:
            return "", (result.stderr or result.stdout or "tailwindcss a echoue")
        return out_css.read_text(encoding="utf-8"), None
    finally:
        out_css.unlink(missing_ok=True)
