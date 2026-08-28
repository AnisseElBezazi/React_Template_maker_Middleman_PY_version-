import re
from pathlib import Path

from cvsmart.shared.paths_service import NODE_TOOLS_ROOT, TEMPLATES_ROOT

PROMPTS_ROOT = NODE_TOOLS_ROOT / "prompts"

FENCE_RE = re.compile(r"```(?:jsx|javascript|js)?\n([\s\S]*?)```")
# Les lignes de declaration attachees au JSX (EXTRA_IMAGES, ASSETS) sont lues
# separement depuis la reponse brute ; laissees dans le fichier, elles le
# rendent invalide.
TRAILING_DECL_RE = re.compile(r"^\s*(?:EXTRA_IMAGES|ASSETS)\s*:\s*[\[{][\s\S]*?[\]}]\s*;?\s*$", re.MULTILINE)


def read_prompt_template(name: str) -> str:
    """NE JAMAIS reformuler le contenu de ces fichiers : des heures de
    calibrage y sont investies. Lus tels quels, ici comme cote Node."""
    return (PROMPTS_ROOT / name).read_text(encoding="utf-8")


def read_template_file(rel: str) -> str:
    return (TEMPLATES_ROOT / rel).read_text(encoding="utf-8")


def extract_code(text: str) -> str:
    fenced = FENCE_RE.search(text)
    code = (fenced.group(1) if fenced else text).strip()
    code = TRAILING_DECL_RE.sub("", code).strip()
    return code


def assert_valid_jsx(code: str, step: str) -> None:
    """Echoue vite avec un message clair si la reponse extraite n'a
    manifestement pas de JSX exploitable (ex: max_tokens entierement
    consomme par la reflexion etendue, reponse vide)."""
    if not code or "export default" not in code:
        raise RuntimeError(
            f"Passe {step} : reponse du modele sans JSX exploitable (probablement max_tokens "
            f"entierement consomme par la reflexion, sans place pour la reponse finale -- "
            f"reessaie, ou augmente max_tokens)."
        )
