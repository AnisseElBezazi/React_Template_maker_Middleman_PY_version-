import json
import re
import shutil
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


def _extract_numbered_text(file: Path) -> str:
    """CV cible uniquement : chaque paragraphe est numerote, pour que Kimi
    reference des index plutot que de devoir recopier du texte caractere
    pour caractere (fragile -- voir replace_in_docx.py)."""
    result = subprocess.run(
        [_python_bin(), str(DOCX_TO_NUMBERED_TEXT_PY), str(file)], capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Extraction docx échouée: {result.stderr}")
    return result.stdout


def _render_preview_pages(docx_path: Path, out_dir: Path, prefix: str) -> int:
    """Convertit docx_path en PDF (LibreOffice) puis en PNG par page (poppler),
    enregistres dans out_dir sous `{prefix}-page-1.png`, `{prefix}-page-2.png`...
    -- pour la preview cote a cote CV original / template Jinja brut (balises
    visibles, aucun rendu de donnees). Best-effort : si LibreOffice/poppler ne
    sont pas installes ou echouent, renvoie 0 -- le reste du pipeline (deja
    termine a ce stade) n'en depend pas."""
    soffice = shutil.which("soffice")
    pdftoppm = shutil.which("pdftoppm")
    if not soffice or not pdftoppm:
        return 0
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(docx_path)],
            capture_output=True, timeout=120,
        )
        pdf_path = out_dir / (docx_path.stem + ".pdf")
        if not pdf_path.exists():
            return 0
        raw_prefix = out_dir / f"{prefix}-raw"
        subprocess.run(
            [pdftoppm, "-png", "-r", "100", str(pdf_path), str(raw_prefix)],
            capture_output=True, timeout=120,
        )
        # pdftoppm pade le numero de page a la largeur du total (ex: "-01.png"
        # a "-12.png" des 10 pages) -- on renomme vers un schema SANS padding
        # pour que le front construise les URLs par simple boucle 1..N.
        pages = sorted(out_dir.glob(f"{prefix}-raw-*.png"))
        for i, page_path in enumerate(pages, start=1):
            page_path.rename(out_dir / f"{prefix}-page-{i}.png")
        pdf_path.unlink(missing_ok=True)
        return len(pages)
    except Exception:
        return 0


def _extract_json(text: str):
    fenced = FENCE_RE.search(text)
    raw = (fenced.group(1) if fenced else text).strip()
    return json.loads(raw)


def _extract_blocks(text: str) -> list[str]:
    """Extrait les blocs ```markdown de la reponse de la passe 3 (le Global
    Prompt puis l'Experience Prompt). Ne PAS utiliser une regex non-gourmande
    generique (```(?:markdown)?\\n([\\s\\S]*?)```) : le prompt genere peut lui-
    meme contenir des ``` imbriques (exemples de code/JSON illustratifs --
    l'exemple de reference `Experience Data Prompt.md` en a plusieurs, et
    Kimi reproduit ce style) -- une regex non-gourmande s'arrete au PREMIER
    ``` trouve, meme s'il est A L'INTERIEUR du bloc, tronquant silencieusement
    tout ce qui suit (aucune erreur, juste un fichier incomplet). On decoupe
    donc sur "```markdown" precisement (jamais utilise pour un exemple
    imbrique dans un document deja markdown) plutot que sur "```" seul."""
    matches = list(re.finditer(r"```markdown\s*\n", text))
    blocks = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end]
        last_fence = chunk.rfind("```")
        if last_fence != -1:
            chunk = chunk[:last_fence]
        blocks.append(chunk.strip())
    return blocks


def _check_finish_reason(step: str, finish_reason: str | None) -> None:
    # Kimi peut consommer tout max_tokens en reflexion (reasoning) sans qu'il
    # en reste pour la reponse -- content arrive alors vide, et le JSON.loads
    # qui suit echoue avec un "Expecting value: line 1 column 1" totalement
    # opaque. On le detecte ici pour donner un message clair a la place.
    if finish_reason == "length":
        raise RuntimeError(
            f"Passe {step} : reponse coupee au plafond de tokens de sortie "
            f'(finish_reason="length"). Le modele n\'a pas eu la place d\'ecrire '
            f"sa reponse apres avoir reflechi -- augmente max_tokens."
        )


def _stream_chat(client, step: str, messages: list[dict], on_stream: Callable[[str, str, str], None],
                  tools: list[dict] | None = None, effort: str | None = None) -> tuple[str, list[dict], str | None, PassUsage]:
    """Appel Moonshot en streaming : renvoie (content, tool_calls, finish_reason, usage).
    tool_calls est une liste de {"id", "function": {"name", "arguments"}}
    reconstituee a partir des deltas -- l'API les envoie fragment par
    fragment (nom et arguments arrivent morceau par morceau, indexes par
    position), meme chose que le texte/la reflexion.
    usage/cout calcules exactement comme _call_moonshot (model_client_service.py) --
    meme table de tarifs (RATE), meme traitement du cache (facture selon RATE["cache"],
    a part du reste de l'entree) -- pour que les deux pipelines restent
    comparables plutot que de diverger sur deux formules independantes."""
    kwargs = dict(model=MODEL, messages=messages, stream=True, stream_options={"include_usage": True})
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    if effort in EFFORTS:
        kwargs["reasoning_effort"] = effort

    stream = client.chat.completions.create(**kwargs)
    text_buf, thinking_buf = "", ""
    tool_calls_acc: dict[int, dict] = {}
    finish_reason = None
    usage = None

    for chunk in stream:
        if chunk.usage:
            usage = chunk.usage
        if chunk.choices and chunk.choices[0].finish_reason:
            finish_reason = chunk.choices[0].finish_reason
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta

        reasoning = getattr(delta, "reasoning_content", None)
        if reasoning:
            thinking_buf += reasoning
            on_stream(step, "thinking", thinking_buf[-4000:])
        if delta.content:
            text_buf += delta.content
            on_stream(step, "text", text_buf[-4000:])
        if delta.tool_calls:
            for tc_delta in delta.tool_calls:
                entry = tool_calls_acc.setdefault(tc_delta.index, {"id": None, "name": "", "arguments": ""})
                if tc_delta.id:
                    entry["id"] = tc_delta.id
                if tc_delta.function:
                    if tc_delta.function.name:
                        entry["name"] += tc_delta.function.name
                    if tc_delta.function.arguments:
                        entry["arguments"] += tc_delta.function.arguments

    tool_calls = [
        {"id": v["id"], "function": {"name": v["name"], "arguments": v["arguments"]}}
        for _, v in sorted(tool_calls_acc.items())
    ]

    cached = 0
    if usage and usage.prompt_tokens_details:
        cached = usage.prompt_tokens_details.cached_tokens or 0
    input_tokens = (usage.prompt_tokens if usage else 0) - cached
    output_tokens = usage.completion_tokens if usage else 0
    cost = round((input_tokens * RATE["in"] + output_tokens * RATE["out"] + cached * RATE.get("cache", 0.3)) / 1e6, 4)
    pass_usage = PassUsage(
        step=step, effort=effort or "", input_tokens=input_tokens, output_tokens=output_tokens,
        cache_read_tokens=cached, cache_write_tokens=0, cost_usd=cost,
    )

    return text_buf, tool_calls, finish_reason, pass_usage


def _extract_real_cvdata(client, cv_text: str, on_stream: Callable[[str, str, str], None],
                          per_pass_usage: list[PassUsage]) -> dict | None:
    """Fait tourner les VRAIS prompts d'extraction de la pipeline CV Smart
    (texte -> JSON structure standard) sur le CV cible, pour donner a la
    passe 1 des valeurs deja identifiees plutot que de lui faire deviner
    la structure ET la position des paragraphes en meme temps. Ces deux
    prompts sont deja ecrits et eprouves ; on ne fait que les brancher.
    Aide optionnelle : si l'extraction echoue, la passe 1 continue sans,
    exactement comme avant."""
    result: dict = {}
    for step, prompt_path in (("extract_data", DATA_GLOBAL_PROMPT), ("extract_data", DATA_EXPERIENCES_PROMPT)):
        try:
            prompt = prompt_path.read_text(encoding="utf-8").replace(DATA_EXTRACTION_PLACEHOLDER, cv_text)
            # effort "low" : cette extraction ne fait que suivre un schema JSON
            # fixe sur du texte deja present dans le CV -- aucun raisonnement
            # profond requis, contrairement a la passe 1 qui doit elle
            # localiser precisement chaque valeur dans les paragraphes numerotes.
            content, _, finish_reason, usage = _stream_chat(client, step, [{"role": "user", "content": prompt}], on_stream, effort="low")
            per_pass_usage.append(usage)
            if finish_reason == "length":
                continue
            parsed = _extract_json(content)
            if isinstance(parsed, dict):
                result.update(parsed)
        except Exception:
            # Aide optionnelle -- une extraction ratee ne doit jamais faire
            # echouer tout le run, la passe 1 sait deja travailler sans.
            continue
    return result or None


def _run_pass1_agentic(client, sys_pass1: str, total_paragraphs: int,
                        on_progress: Callable[[str, str], None], on_stream: Callable[[str, str, str], None],
                        should_cancel: Callable[[], bool], per_pass_usage: list[PassUsage],
                        effort: str = "high") -> list[dict]:
    """Passe 1, en boucle d'outils plutot qu'en un seul appel qui devine tout
    d'un coup. Kimi appelle set_paragraphs autant de fois que necessaire (un
    ou plusieurs par tour), et voit apres chaque appel combien de paragraphes
    restent a traiter -- il peut alors reprendre le travail au lieu de
    s'arreter tot en ayant couvert seulement les cas faciles. Aucune analyse
    de JSON en texte libre necessaire : les arguments d'un tool call sont
    deja structures par l'API."""
    messages = [{"role": "user", "content": sys_pass1}]
    edits: list[dict] = []
    covered: set[int] = set()
    max_iterations = 60

    for iteration in range(max_iterations):
        if should_cancel():
            raise RunCancelled("Run annulé par l'utilisateur.")
        on_progress("pass1", f"Passe 1/3 : mapping Jinja -- {len(covered)}/{total_paragraphs} paragraphes couverts (tour {iteration + 1})...")

        content, tool_calls, finish_reason, usage = _stream_chat(client, "pass1", messages, on_stream, tools=PASS1_TOOLS, effort=effort)
        per_pass_usage.append(usage)
        _check_finish_reason("1", finish_reason)

        messages.append({
            "role": "assistant",
            "content": content or None,
            "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}}
                for tc in tool_calls
            ] or None,
        })

        if not tool_calls:
            # Pas d'appel d'outil : le modele considere avoir fini sans
            # passer par finish(). On s'arrete quand meme plutot que de
            # boucler indefiniment sur un modele qui ne joue pas le jeu.
            break

        finished = False
        for call in tool_calls:
            try:
                args = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}

            name = call["function"]["name"]
            if name == "finish":
                finished = True
                tool_result = "Termine."
            elif name == "set_paragraphs":
                raw_idxs = args.get("paragraphs", [])
                raw_replaces = args.get("replace", [])
                if isinstance(raw_replaces, str):
                    # Sur les gros groupes (des dizaines de paragraphes,
                    # souvent surtout des chaines vides), Kimi degenere
                    # parfois et renvoie tout le tableau encode une fois de
                    # trop, sous forme de texte litteral ('["a", "", ...]').
                    # On tente de le redecoder plutot que de recopier cette
                    # chaine telle quelle sur chaque paragraphe du groupe.
                    try:
                        decoded = json.loads(raw_replaces)
                        if isinstance(decoded, list):
                            raw_replaces = decoded
                    except (json.JSONDecodeError, TypeError):
                        pass
                if not isinstance(raw_replaces, list):
                    raw_replaces = [raw_replaces]

                if len(raw_replaces) > len(raw_idxs):
                    tool_result = (
                        f"Erreur : replace a {len(raw_replaces)} element(s) pour seulement "
                        f"{len(raw_idxs)} paragraphs -- replace ne peut pas etre plus long. Reessaie."
                    )
                else:
                    # replace peut etre plus court que paragraphs : les
                    # paragraphes au-dela sont vides automatiquement (plus
                    # besoin d'ecrire des dizaines de "" a la main).
                    idxs, texts = [], []
                    for i, idx in enumerate(raw_idxs):
                        if isinstance(idx, int) and 0 <= idx < total_paragraphs:
                            idxs.append(idx)
                            texts.append(raw_replaces[i] if i < len(raw_replaces) else "")
                    if idxs:
                        edits.append({"paragraphs": idxs, "replace": texts})
                        covered.update(idxs)
                    tool_result = f"Enregistre. {len(covered)}/{total_paragraphs} paragraphes couverts au total."
            else:
                tool_result = f"Outil inconnu : {name}"

            messages.append({"role": "tool", "tool_call_id": call["id"], "content": tool_result})

        if finished:
            break

    return edits


@dataclass
class JinjaPipelineResult:
    template_path: Path
    global_prompt_path: Path
    experience_prompt_path: Path
    config_path: Path
    per_pass_usage: list[PassUsage]
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: int
    cost_usd: float
    source_page_count: int
    template_page_count: int


def run_jinja_pipeline(
    cv_path: Path,
    out_dir: Path,
    api_key: str,
    on_progress: Callable[[str, str], None] = lambda step, message: None,
    on_stream: Callable[[str, str, str], None] = lambda step, kind, text: None,
    should_cancel: Callable[[], bool] = lambda: False,
    effort: str = "high",
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

    # Extraction reelle (memes prompts que la pipeline CV Smart de
    # production) : donne a la passe 1 les valeurs deja identifiees, pour
    # qu'elle n'ait plus qu'a les localiser dans les paragraphes numerotes
    # au lieu de deviner structure ET position en meme temps. Aide
    # optionnelle -- None si l'extraction echoue, la passe 1 s'en passe.
    on_progress("extract", "Extraction des données réelles du CV (aide pour la passe 1)...")
    real_cvdata = _extract_real_cvdata(client, cv_text, on_stream, per_pass_usage)
    real_cvdata_json = json.dumps(real_cvdata, indent=2, ensure_ascii=False) if real_cvdata else "(indisponible)"

    # --- Passe 1 : REPLACEMENTS ---
    on_progress("pass1", "Passe 1/3 : Mapping Jinja du document...")
    sys_pass1 = ((PROMPTS_ROOT / "jinja_pass1_replacements.md").read_text(encoding="utf-8")
                 .replace("{SAMPLE_CVDATA}", sample_cv_data)
                 .replace("{CV_TEXT}", cv_text_numbered)
                 .replace("{EXAMPLE_TEMPLATE_TEXT}", example_template_text)
                 .replace("{REAL_CVDATA}", real_cvdata_json))

    total_paragraphs = max((int(m) for m in NUMBERED_LINE_RE.findall(cv_text_numbered)), default=-1) + 1
    replacements_obj = _run_pass1_agentic(client, sys_pass1, total_paragraphs, on_progress, on_stream, should_cancel, per_pass_usage, effort)

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

    content2, _, finish_reason2, usage2 = _stream_chat(client, "pass2", [{"role": "user", "content": sys_pass2}], on_stream, effort=effort)
    per_pass_usage.append(usage2)
    _check_finish_reason("2", finish_reason2)
    try:
        extra_config_obj = _extract_json(content2)
    except (json.JSONDecodeError, ValueError) as err:
        raise RuntimeError(f"Passe 2 échouée : JSON Invalide. {err}\nRéponse brute : {content2}") from err

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

    content3, _, finish_reason3, usage3 = _stream_chat(client, "pass3", [{"role": "user", "content": sys_pass3}], on_stream, effort=effort)
    per_pass_usage.append(usage3)
    _check_finish_reason("3", finish_reason3)
    blocks_pass3 = _extract_blocks(content3)
    if len(blocks_pass3) < 2:
        raise RuntimeError("Passe 3 échouée : Prompts manquants.")
    global_prompt_text, exp_prompt_text = blocks_pass3[0], blocks_pass3[1]

    global_prompt_out = out_dir / "global_prompt.md"
    exp_prompt_out = out_dir / "experience_prompt.md"
    global_prompt_out.write_text(global_prompt_text or "", encoding="utf-8")
    exp_prompt_out.write_text(exp_prompt_text or "", encoding="utf-8")

    # --- Passe 4 : VERIFICATION DES BALISES FERMANTES (rapide, effort bas) ---
    # Dernier filet AVANT le rendu : verifie UNIQUEMENT que chaque {%p/tr
    # if/for%} ferme dans la meme famille et le meme conteneur (voir
    # jinja_pass4_verify.md) -- exactement la classe de bug deja detectee et
    # partiellement corrigee cote code (_fix_flavor_mismatches,
    # _fix_stranded_markers). Aide optionnelle et volontairement etroite : si
    # la reponse est invalide/inexploitable, on continue avec les
    # remplacements de la passe 1 tels quels plutot que de faire echouer tout
    # le run pour une simple relecture ratee.
    on_progress("pass4", "Passe 4 : vérification des balises fermantes...")
    sys_pass4 = ((PROMPTS_ROOT / "jinja_pass4_verify.md").read_text(encoding="utf-8")
                 .replace("{CV_TEXT}", cv_text_numbered)
                 .replace("{REPLACEMENTS}", replacements_str))
    try:
        content4, _, finish_reason4, usage4 = _stream_chat(
            client, "pass4", [{"role": "user", "content": sys_pass4}], on_stream, effort="low",
        )
        per_pass_usage.append(usage4)
        if finish_reason4 != "length":
            verified = _extract_json(content4)
            if isinstance(verified, list):
                replacements_obj = verified
                replacements_str = json.dumps(replacements_obj, indent=2, ensure_ascii=False)
                replacements_out.write_text(replacements_str, encoding="utf-8")
    except Exception:
        # Verification optionnelle -- une passe 4 ratee ne doit jamais faire
        # echouer tout le run, le rendu continue avec la passe 1 telle quelle.
        pass

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
