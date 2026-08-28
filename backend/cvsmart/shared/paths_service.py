from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BACKEND_ROOT.parent
TEMPLATES_ROOT = PROJECT_ROOT / "templates copy"

# Racine des outils Node restants (esbuild, tailwindcss), appeles en
# sous-processus comme n'importe quel binaire externe.
NODE_TOOLS_ROOT = PROJECT_ROOT / "pipeline"

# Les runs et les PDF televerses restent ou ils sont pendant la migration :
# des centaines de dossiers de runs existants doivent rester ouvrables sans
# etre deplaces.
OUT_ROOT = NODE_TOOLS_ROOT / "out"
UPLOADS_ROOT = NODE_TOOLS_ROOT / "uploads"
PIPELINE_SAMPLE_CVDATA = NODE_TOOLS_ROOT / "sample_cvdata.json"


def ensure_roots() -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)


def to_public_url(abs_path: Path) -> str:
    return "/out/" + str(abs_path.relative_to(OUT_ROOT)).replace("\\", "/")
