import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import openai

from cvsmart.shared.paths_service import PROJECT_ROOT, NODE_TOOLS_ROOT
from cvsmart.shared.errors import RunCancelled
from cvsmart.pipeline.services.model_client_service import PassUsage, RATE

MODEL = "kimi-k3.1-pro"
MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"
EFFORTS = {"low", "high", "max"}

EXAMPLE_ROOT = PROJECT_ROOT / "exemple-jinja"
PROMPTS_ROOT = NODE_TOOLS_ROOT / "prompts"
DOCX_TO_TEXT_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "docx_to_text.py"
DOCX_TO_NUMBERED_TEXT_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "docx_to_numbered_text.py"
REPLACE_IN_DOCX_PY = NODE_TOOLS_ROOT / "src" / "extraction" / "replace_in_docx.py"

FENCE_RE = re.compile(r"```(?:json)?\n([\s\S]*?)```")
NUMBERED_LINE_RE = re.compile(r"^\[(\d+)\]", re.MULTILINE)

# data_global.md / data_experiences.md sont les VRAIS prompts d'extraction
# texte -> JSON de la pipeline CV Smart de production (meme schema que
# sample_cvdata.json), deja ecrits et eprouves -- mais jamais branches nulle
# part dans ce repo jusqu'ici. Le placeholder est celui deja utilise dedans.
DATA_GLOBAL_PROMPT = PROMPTS_ROOT / "data_global.md"
DATA_EXPERIENCES_PROMPT = PROMPTS_ROOT / "data_experiences.md"
DATA_EXTRACTION_PLACEHOLDER = "<<IYHA-!hSJ!-l24>>"

PASS1_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "set_paragraphs",
            "description": (
                "Remplace le texte d'un ou plusieurs paragraphes du CV cible par du "
                "contenu Jinja. Chaque paragraphe garde SA PLACE et SA PROPRE mise en "
                "forme (police, taille, gras...) -- rien n'est fusionne ni supprime. "
                "replace[i] devient le nouveau texte du paragraphe paragraphs[i], dans "
                "l'ordre. IMPORTANT : replace peut avoir MOINS d'elements que paragraphs "
                "-- n'ecris que les textes reellement utiles (dans l'ordre des paragraphes "
                "concernes), tous les paragraphes RESTANTS de la liste sont vides "
                "automatiquement. N'ecris JAMAIS toi-meme une longue suite de chaines "
                "vides '' pour completer : omets-les, le systeme s'en charge. Appelle cet "
                "outil une fois par groupe de paragraphes identifie -- autant de fois que "
                "necessaire pour couvrir tout le document."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paragraphs": {
                        "type": "array", "items": {"type": "integer"},
                        "description": "Index des paragraphes concernes (voir le CV numerote), y compris ceux qui seront vides.",
                    },
                    "replace": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Nouveau texte pour les premiers paragraphes de `paragraphs`, dans le meme ordre. Peut etre plus court que `paragraphs` -- ne liste QUE les textes non vides, n'ajoute pas de '' de remplissage.",
                    },
                },
                "required": ["paragraphs", "replace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finish",
            "description": (
                "A appeler UNE SEULE FOIS, quand TOUS les paragraphes du CV contenant "
                "des donnees factices ont ete traites via set_paragraphs -- seuls les "
                "titres de section fixes doivent rester intouches. N'appelle jamais "
                "cet outil avant d'avoir parcouru l'integralite du CV numerote."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _python_bin() -> str:
    return sys.executable


def _extract_text(file: Path) -> str:
    if str(file).lower().endswith(".docx"):
        result = subprocess.run([_python_bin(), str(DOCX_TO_TEXT_PY), str(file)], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"Extraction docx échouée: {result.stderr}")
        return result.stdout
    return Path(file).read_text(encoding="utf-8")


def _extract_json(text: str):
    fenced = FENCE_RE.search(text)
    raw = (fenced.group(1) if fenced else text).strip()
    return json.loads(raw)


def _extract_blocks(text: str) -> list[str]:
    return [m.strip() for m in BLOCKS_RE.findall(text)]


def _salvage_json_array(text: str):
    t = text.strip()
    fenced = FENCE_RE.search(t)
    if fenced:
        t = fenced.group(1).strip()
    else:
        t = re.sub(r"^```json\n?", "", t)
        t = re.sub(r"```$", "", t).strip()

    if t.startswith("["):
        last_brace = t.rfind("}")
        if last_brace != -1:
            salvaged = t[:last_brace + 1] + "]"
            try:
                return json.loads(salvaged)
            except json.JSONDecodeError:
                return None
    return None


@dataclass
class JinjaPipelineResult:
    template_path: Path
    global_prompt_path: Path
    experience_prompt_path: Path
    config_path: Path


def run_jinja_pipeline(
    cv_path: Path,
    out_dir: Path,
    api_key: str,
    on_progress: Callable[[str, str], None] = lambda step, message: None,
) -> JinjaPipelineResult:
    """Pipeline INVERSE de la pipeline principale : part d'un .docx de CV
    REMPLI (donnees factices) et en derive le template Jinja non rempli, sa
    extra_config, et les 2 prompts d'extraction -- pour amorcer un nouveau
    template CV Smart a partir d'un exemple client."""
    if not api_key:
        raise RuntimeError("Clé API Moonshot manquante.")

    client = openai.OpenAI(api_key=api_key, base_url=MOONSHOT_BASE_URL)

    # 1. Extraction de texte du docx modèle
    on_progress("extract", "Extraction du texte du modèle de CV...")
    cv_text = _extract_text(cv_path)

    example_config_text = (EXAMPLE_ROOT / "extra-config-visian.json").read_text(encoding="utf-8")
    example_global = (EXAMPLE_ROOT / "Visian - Global Data Prompt.md").read_text(encoding="utf-8")
    example_exp = (EXAMPLE_ROOT / "Visian - Experience Data Prompt.md").read_text(encoding="utf-8")
    sample_cv_data = (NODE_TOOLS_ROOT / "sample_cvdata.json").read_text(encoding="utf-8")

    on_progress("extract", "Extraction du texte du template Jinja d'exemple...")
    example_template_text = _extract_text(EXAMPLE_ROOT / "Template_Visian_pWLzXxC.docx")

    # --- Passe 1 : REPLACEMENTS ---
    on_progress("pass1", "Passe 1/3 : Mapping Jinja du document...")
    sys_pass1 = ((PROMPTS_ROOT / "jinja_pass1_replacements.md").read_text(encoding="utf-8")
                 .replace("{SAMPLE_CVDATA}", sample_cv_data)
                 .replace("{CV_TEXT}", cv_text)
                 .replace("{EXAMPLE_TEMPLATE_TEXT}", example_template_text))

    res_pass1 = client.chat.completions.create(
        model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": sys_pass1}],
    )
    content1 = res_pass1.choices[0].message.content
    try:
        replacements_obj = _extract_json(content1)
    except (json.JSONDecodeError, ValueError) as err:
        replacements_obj = _salvage_json_array(content1)
        if replacements_obj is None:
            raise RuntimeError(f"Passe 1 échouée : JSON Invalide. {err}\nRéponse brute : {content1}") from err
        print(f"Passe 1 : JSON tronqué récupéré avec succès ({len(replacements_obj)} éléments).")

    replacements_str = json.dumps(replacements_obj or [], indent=2, ensure_ascii=False)
    replacements_out = out_dir / "replacements.json"
    replacements_out.write_text(replacements_str, encoding="utf-8")

    # --- Passe 2 : EXTRA CONFIG ---
    on_progress("pass2", "Passe 2/3 : Génération de l'extra_config...")
    sys_pass2 = ((PROMPTS_ROOT / "jinja_pass2_config.md").read_text(encoding="utf-8")
                 .replace("{SAMPLE_CVDATA}", sample_cv_data)
                 .replace("{EXAMPLE_CONFIG}", example_config_text)
                 .replace("{CV_TEXT}", cv_text)
                 .replace("{REPLACEMENTS}", replacements_str))

    # max_tokens manquait ici (present sur les passes 1 et 3) alors que
    # l'extra_config est le plus gros JSON des 3 sorties -- le plus expose a
    # une troncature silencieuse sur le defaut de l'API.
    res_pass2 = client.chat.completions.create(
        model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": sys_pass2}],
    )
    try:
        extra_config_obj = _extract_json(res_pass2.choices[0].message.content)
    except (json.JSONDecodeError, ValueError) as err:
        raise RuntimeError(f"Passe 2 échouée : JSON Invalide. {err}") from err

    extra_config_str = json.dumps(extra_config_obj, indent=2, ensure_ascii=False)
    config_out = out_dir / "extra_config.json"
    config_out.write_text(extra_config_str, encoding="utf-8")

    # --- Passe 3 : PROMPTS MARKDOWN ---
    on_progress("pass3", "Passe 3/3 : Génération des prompts d'extraction...")
    sys_pass3 = ((PROMPTS_ROOT / "jinja_pass3_prompts.md").read_text(encoding="utf-8")
                 .replace("{EXAMPLE_GLOBAL}", example_global)
                 .replace("{EXAMPLE_EXP}", example_exp)
                 .replace("{SAMPLE_CVDATA}", sample_cv_data)
                 .replace("{EXTRA_CONFIG}", extra_config_str)
                 .replace("{CV_TEXT}", cv_text))

    res_pass3 = client.chat.completions.create(
        model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": sys_pass3}],
    )
    blocks_pass3 = _extract_blocks(res_pass3.choices[0].message.content)
    if len(blocks_pass3) < 2:
        raise RuntimeError("Passe 3 échouée : Prompts manquants.")
    global_prompt_text, exp_prompt_text = blocks_pass3[0], blocks_pass3[1]

    global_prompt_out = out_dir / "global_prompt.md"
    exp_prompt_out = out_dir / "experience_prompt.md"
    global_prompt_out.write_text(global_prompt_text or "", encoding="utf-8")
    exp_prompt_out.write_text(exp_prompt_text or "", encoding="utf-8")

    # 5. Modification du .docx
    on_progress("render", "Génération finale du template .docx...")
    template_out_path = out_dir / "template.docx"
    render_result = subprocess.run(
        [_python_bin(), str(REPLACE_IN_DOCX_PY), str(cv_path), str(replacements_out), str(template_out_path)],
        capture_output=True, text=True,
    )
    if render_result.returncode != 0:
        raise RuntimeError(f"Erreur génération docx: {render_result.stderr or render_result.stdout}")

    on_progress("done", "Terminé")
    return JinjaPipelineResult(
        template_path=template_out_path, global_prompt_path=global_prompt_out,
        experience_prompt_path=exp_prompt_out, config_path=config_out,
    )
