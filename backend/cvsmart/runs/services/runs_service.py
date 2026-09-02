import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cvsmart.shared.paths_service import OUT_ROOT, UPLOADS_ROOT, to_public_url
from cvsmart.rendering.services.target_service import (
    stacked_target, target_pages, png_size, PAGE_GAP,
)

PASS_LABELS = {
    "attempt1": "Passe 1 -- premier jet",
    "attempt2": "Passe 2 -- diff visuel",
    "attempt3": "Passe 3 -- audit",
    "final": "Passe 4+5 -- corrections de taille",
}

PASS_ORDER = ["attempt1", "attempt2", "attempt3", "final"]

# Les runs en cours vivent en memoire ; leurs fichiers, eux, restent sur le
# disque, ce qui permet de rouvrir un ancien resultat apres redemarrage.
_runs: dict[str, dict[str, Any]] = {}

MS_ID_RE = re.compile(r"^\d{13}-")


def register_run(run_id: str, state: dict[str, Any]) -> None:
    _runs[run_id] = state


def request_cancel(run_id: str) -> bool:
    """Marque un run en cours pour annulation. La pipeline le remarque a la
    prochaine etape franchie (on_progress) ou au prochain chunk de reponse
    en streaming -- pas instantane, mais sans jamais laisser un run bloque."""
    state = _runs.get(run_id)
    if not state or state.get("status") != "running":
        return False
    state["cancel_requested"] = True
    return True


def live_run(run_id: str) -> dict[str, Any] | None:
    return _runs.get(run_id)


def _run_time(dir_name: str) -> float:
    """Deux conventions cohabitent dans out/ : un horodatage en millisecondes
    (runs recents) et un ISO avec tirets (anciens). La date du dossier couvre
    les deux sans avoir a deviner le format du nom."""
    if MS_ID_RE.match(dir_name):
        try:
            return int(dir_name[:13])
        except ValueError:
            pass
    try:
        return (OUT_ROOT / dir_name).stat().st_mtime * 1000
    except OSError:
        return 0


def _past_run_ids(limit: int = 14) -> list[str]:
    if not OUT_ROOT.exists():
        return []
    # Le Node d'origine cherche "attempt1.jsx" OU "result.docx" -- mais la
    # pipeline jinja n'a jamais ecrit result.docx (voir _rehydrate_run), donc
    # ses runs etaient invisibles dans le rail "Runs" des le rechargement.
    # On reconnait ici le vrai fichier ecrit : template.docx.
    dirs = [d.name for d in OUT_ROOT.iterdir()
            if (d / "attempt1.jsx").exists() or (d / "template.docx").exists()]
    dirs.sort(key=_run_time, reverse=True)
    return dirs[:limit]


def list_runs(limit: int = 14) -> list[dict[str, Any]]:
    """Historique pret a afficher. Dates en ISO 8601 : c'est le front qui
    decide du format lisible, pas le backend."""
    out = []
    for run_id in _past_run_ids(limit):
        ms = _run_time(run_id)
        started_at = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else None
        out.append({"run_id": run_id, "started_at": started_at})
    return out


def _rehydrate_run(run_id: str) -> dict[str, Any] | None:
    """Reconstruit un etat minimal a partir du dossier du run, pour rouvrir un
    ancien resultat (et y retoucher les images) sans relancer de generation
    payante."""
    out_dir = OUT_ROOT / run_id
    if not out_dir.exists():
        return None

    meta: dict[str, Any] = {}
    meta_file = out_dir / "run-meta.json"
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}

    run_type = meta.get("type", "jsx")
    if run_type == "jinja":
        # Corrige par rapport au Node d'origine : la pipeline jinja ecrit
        # template.docx (jamais result.docx/data.json), donc son garde-fou
        # de rehydratation ne trouvait jamais rien apres un redemarrage du
        # serveur. On verifie les vrais fichiers produits.
        if not (out_dir / "template.docx").exists():
            return None
        pdf_url = meta.get("pdfUrl")
        if pdf_url and not (UPLOADS_ROOT / Path(pdf_url).name).exists():
            pdf_url = None
        return {
            "run_id": run_id, "status": "done", "step": "done",
            "message": "Rechargé depuis le disque.", "log": [], "error": None,
            "restored": True, "type": "jinja", "pdf_url": pdf_url,
            "result": {
                "out_dir": str(out_dir),
                "template_url": to_public_url(out_dir / "template.docx"),
                "global_prompt_url": to_public_url(out_dir / "global_prompt.md"),
                "experience_prompt_url": to_public_url(out_dir / "experience_prompt.md"),
                "config_url": to_public_url(out_dir / "extra_config.json"),
            },
        }

    passes = []
    for name in PASS_ORDER:
        jsx_path = out_dir / f"{name}.jsx"
        png_path = out_dir / f"{name}.png"
        if jsx_path.exists() and png_path.exists():
            html_path = out_dir / f"{name}.html"
            passes.append({
                "name": name,
                "label": PASS_LABELS[name],
                "png_url": to_public_url(png_path),
                "html_url": to_public_url(html_path) if html_path.exists() else None,
            })
    if not passes:
        return None

    # Dimensions : celles d'UNE page, pas de l'empilement -- elles servent de
    # taille de canevas au rendu et a l'editeur.
    pages = target_pages(out_dir)
    width, height = meta.get("width"), meta.get("height")
    if (not width or not height) and pages:
        size = png_size(pages[0])
        if size:
            width, height = size

    stacked = stacked_target(out_dir) if pages else None

    pdf_url = meta.get("pdfUrl")
    if pdf_url and not (UPLOADS_ROOT / Path(pdf_url).name).exists():
        pdf_url = None

    effort = meta.get("effort")
    if not effort:
        for entry in meta.get("perPass", []):
            if entry.get("step") == "pass1":
                effort = entry.get("effort")
                break

    # Hauteurs REELLES des deux planches : le front ne mesure pas des PNG.
    # Elles different legitimement -- le moteur de pagination emet autant de
    # pages que les donnees l'exigent, pas forcement autant que la cible.
    target_page_heights = [size[1] for p in pages if (size := png_size(p))]
    final_name = passes[-1]["name"]
    preview_page_heights = _page_heights(out_dir, final_name)

    def stack_height(heights):
        if not heights:
            return height or 0
        return sum(heights) + PAGE_GAP * (len(heights) - 1)

    target_height = stack_height(target_page_heights)
    preview_height = stack_height(preview_page_heights)

    tokens = meta.get("tokens", {})
    return {
        "run_id": run_id,
        "status": "done",
        "step": "done",
        "message": "Recharge depuis le disque.",
        "log": [],
        "error": None,
        "restored": True,
        "pdf_url": pdf_url,
        "target_url": to_public_url(stacked) if stacked else None,
        "page": meta.get("page", 1),
        "effort": effort,
        "cost_usd": meta.get("costUsd"),
        "result": {
            "out_dir": str(out_dir),
            "width": width,
            "height": height,
            "page_count": len(pages),
            "target_height": target_height,
            "preview_height": preview_height,
            "world_height": max(target_height, preview_height),
            "target_page_heights": target_page_heights,
            "preview_page_heights": preview_page_heights,
            "passes": passes,
            "total_input_tokens": tokens.get("totalInputTokens"),
            "total_output_tokens": tokens.get("totalOutputTokens"),
            "total_cache_read_tokens": tokens.get("totalCacheReadTokens"),
        },
    }


def _page_heights(out_dir: Path, pass_name: str) -> list[int]:
    """Hauteurs des pages rendues, lues sur les captures par page produites au
    rendu. Une page rendue ne fait pas forcement la hauteur du canevas."""
    heights = []
    index = 1
    while True:
        page_png = out_dir / f"{pass_name}-page-{index}.png"
        if not page_png.exists():
            break
        size = png_size(page_png)
        if not size:
            break
        heights.append(size[1])
        index += 1
    return heights


def get_run(run_id: str) -> dict[str, Any] | None:
    """Recupere un run, depuis la memoire ou, a defaut, depuis le disque."""
    return _runs.get(run_id) or _rehydrate_run(run_id)
