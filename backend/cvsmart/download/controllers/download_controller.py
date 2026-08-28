import io
import zipfile
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from cvsmart.runs.services.runs_service import get_run
from cvsmart.jsx.services.db_format_service import to_db_format
from cvsmart.download.services.download_service import collect_download_assets, compile_template_css


def download_run(run_id: str):
    state = get_run(run_id)
    if not state or state.get("status") != "done":
        raise HTTPException(status_code=404, detail="Run introuvable ou pas terminé.")

    final_pass = state["result"]["passes"][-1]
    # Le pass a ete rehydrate en URL publique : on retrouve le chemin disque
    # a partir de out_dir + nom de fichier plutot que de stocker deux fois.
    out_dir = Path(state["result"]["out_dir"])
    jsx_path = out_dir / f"{final_pass['name']}.jsx"
    assets = collect_download_assets(jsx_path)
    jsx_code, component_name, images = assets["jsx_code"], assets["component_name"], assets["images"]

    # Conversion vers le format de l'app : fichier evalue comme corps de
    # fonction (React/engine injectes) et images lues depuis la base via
    # `assets`. La preview, elle, continue de fonctionner avec les imports.
    try:
        db = to_db_format(jsx_code)
        db["error"] = None
    except Exception as err:
        db = {"error": str(err), "code": None, "assets": [], "component_name": component_name}

    css_result = compile_template_css(db)
    css_source, css_error = css_result["css"], css_result["error"]

    asset_lines = "\n".join(
        f"  {a['key']:<16} <- assets/{a['key']}{Path(a['file']).suffix or '.png'}" for a in db["assets"]
    ) if db["assets"] else "  (aucune image)"

    readme = f"""Composant généré par la pipeline Design-to-Code -- run {run_id}, page {state['page']}.

CONTENU
- {component_name}.jsx        le composant AU FORMAT DE L'APP : évalué comme corps de
                              fonction recevant React et engine, images lues dans l'objet
                              assets. C'est ce fichier qui va dans jsx_source.
- {component_name}.css        le CSS Tailwind DÉJÀ COMPILÉ de ce template, à mettre
                              tel quel dans css_source.
- assets/                     les images du template, nommées par leur clé.
- assets-manifest.json        clé -> fichier, pour l'insertion en base.
- preview/{component_name}.jsx  la version à imports utilisée par la preview locale
                              (même rendu, format différent) -- pour référence.

CLÉS D'IMAGES ATTENDUES DANS assets
{asset_lines}

À SAVOIR
- Le CSS est compilé au moment du téléchargement, depuis le composant tel qu'il est
  à cet instant : les retouches faites dans l'éditeur visuel y sont donc incluses.
- Il ne contient QUE des utilities, jamais base ni components : ces directives
  produisent un reset global qui casserait le style du reste de l'app à l'injection.
- Chaque règle est scopée en `.cv-smart-scope .classe` (option important de Tailwind),
  pour que le CSS du template ne fuie pas sur le reste de l'app.
- Côté app, l'injection se fait sans aucune compilation :
      <div className="cv-smart-scope">
        <style>{{template.css_source}}</style>
        <Component cvData={{cvData}} assets={{assets}} />
      </div>{f'''
- ATTENTION : la compilation du CSS a échoué ({css_error[:200]}), le fichier .css est absent.''' if css_error else ''}
- Ce composant n'a été validé que dans le harness local (React seul + données factices),
  pas dans l'app réelle.
"""

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        if db["error"]:
            zf.writestr("CONVERSION-ECHOUEE.txt", f"La conversion vers le format base a echoue : {db['error']}\n")
        else:
            zf.writestr(f"{component_name}.jsx", db["code"])
            if css_source:
                zf.writestr(f"{component_name}.css", css_source)
            manifest = {a["key"]: f"assets/{a['key']}{Path(a['file']).suffix or '.png'}" for a in db["assets"]}
            import json
            zf.writestr("assets-manifest.json", json.dumps(manifest, indent=2))
            for a in db["assets"]:
                src = next((i for i in images if i["zip_path"].endswith(Path(a["file"]).name)), None)
                if src:
                    zf.write(src["abs"], f"assets/{a['key']}{Path(a['file']).suffix or '.png'}")

        zf.writestr(f"preview/{component_name}.jsx", jsx_code)
        zf.writestr("README.txt", readme)

    buffer.seek(0)
    return StreamingResponse(
        buffer, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{component_name}.zip"'},
    )
