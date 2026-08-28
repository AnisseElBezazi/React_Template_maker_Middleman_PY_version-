from pathlib import Path

from cvsmart.shared.paths_service import PIPELINE_SAMPLE_CVDATA
from cvsmart.rendering.services.render_service import render as render_component


def cv_data_for_run(out_dir: Path) -> Path:
    """Memes donnees que le run d'origine : si un extra_config a ete
    fourni, le JSON derive de ce schema est dans le dossier du run --
    rendre avec le schema generique afficherait d'autres champs que ceux
    que l'utilisateur vient d'ajuster a l'ecran."""
    run_cv_data = out_dir / "generated_cvdata.json"
    return run_cv_data if run_cv_data.exists() else PIPELINE_SAMPLE_CVDATA


def rerender_final_pass(out_dir: Path, jsx_path: Path, png_path: Path, width: int, height: int) -> dict:
    """Re-rend la derniere passe telle quelle (aucun appel modele). Sert aux
    runs generes avant l'ajout des reperes data-cvimg."""
    cv_data_path = cv_data_for_run(out_dir)
    return render_component(jsx_path, cv_data_path, png_path, width, height)
