// Reçoit la requête de téléchargement, appelle les services et assemble le
// zip. Aucune interaction directe avec le disque de la pipeline en dehors des
// services.

import { ZipArchive } from "archiver";
import path from "path";
import { getRun } from "../runs/runs_service.mjs";
import { toDbFormat } from "../jsx/to_db_format.mjs";
import { collectDownloadAssets, compileTemplateCss } from "./download_service.mjs";

export function downloadRun(req, res) {
  const state = getRun(req.params.id);
  if (!state || state.status !== "done") return res.status(404).send("Run introuvable ou pas terminé.");

  const finalPass = state.result.passes.at(-1);
  const { jsxCode, componentName, images } = collectDownloadAssets(finalPass.jsxPath);

  // Conversion vers le format de l'app : fichier évalué comme corps de
  // fonction (React/engine injectés) et images lues depuis la base via
  // `assets`. La preview, elle, continue de fonctionner avec les imports.
  let db = null;
  try {
    db = toDbFormat(jsxCode);
  } catch (err) {
    db = { error: err.message };
  }

  const { css: cssSource, error: cssError } = compileTemplateCss(db);

  const assetLines = db.assets?.length
    ? db.assets.map((a) => `  ${a.key.padEnd(16)} <- assets/${a.key}${path.extname(a.file) || ".png"}`).join("\n")
    : "  (aucune image)";

  const readme = `Composant généré par la pipeline Design-to-Code -- run ${req.params.id}, page ${state.page}.

CONTENU
- ${componentName}.jsx        le composant AU FORMAT DE L'APP : évalué comme corps de
                              fonction recevant React et engine, images lues dans l'objet
                              assets. C'est ce fichier qui va dans jsx_source.
- ${componentName}.css        le CSS Tailwind DÉJÀ COMPILÉ de ce template, à mettre
                              tel quel dans css_source.
- assets/                     les images du template, nommées par leur clé.
- assets-manifest.json        clé -> fichier, pour l'insertion en base.
- preview/${componentName}.jsx  la version à imports utilisée par la preview locale
                              (même rendu, format différent) -- pour référence.

CLÉS D'IMAGES ATTENDUES DANS assets
${assetLines}

À SAVOIR
- Les images sont exposées en portée module (__assets), renseignée par le composant
  principal avant tout rendu enfant : les sous-composants y accèdent sans recevoir la
  prop. C'est correct ici parce qu'un asset appartient au TEMPLATE, pas au CV -- il ne
  change pas d'un candidat à l'autre.
- Le CSS est compilé au moment du téléchargement, depuis le composant tel qu'il est
  à cet instant : les retouches faites dans l'éditeur visuel y sont donc incluses.
- Il ne contient QUE des utilities, jamais base ni components : ces directives
  produisent un reset global qui casserait le style du reste de l'app à l'injection.
- Chaque règle est scopée en \`.cv-smart-scope .classe\` (option important de Tailwind),
  pour que le CSS du template ne fuie pas sur le reste de l'app.
- Côté app, l'injection se fait sans aucune compilation :
      <div className="cv-smart-scope">
        <style>{template.css_source}</style>
        <Component cvData={cvData} assets={assets} />
      </div>${cssError ? `
- ATTENTION : la compilation du CSS a échoué (${cssError.slice(0, 200)}), le fichier .css est absent.` : ""}
- Ce composant n'a été validé que dans le harness local (React seul + données factices),
  pas dans l'app réelle.
`;

  res.attachment(`${componentName}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  if (db.error) {
    archive.append(`La conversion vers le format base a échoué : ${db.error}\n`, { name: "CONVERSION-ECHOUEE.txt" });
  } else {
    archive.append(db.code, { name: `${componentName}.jsx` });
    if (cssSource) archive.append(cssSource, { name: `${componentName}.css` });
    archive.append(
      JSON.stringify(Object.fromEntries(db.assets.map((a) => [a.key, `assets/${a.key}${path.extname(a.file) || ".png"}`])), null, 2),
      { name: "assets-manifest.json" }
    );
    // Les images, renommées par leur clé pour coller au manifeste.
    for (const a of db.assets) {
      const src = images.find((i) => i.zipPath.endsWith(path.basename(a.file)));
      if (src) archive.file(src.abs, { name: `assets/${a.key}${path.extname(a.file) || ".png"}` });
    }
  }

  archive.append(jsxCode, { name: `preview/${componentName}.jsx` });
  archive.append(readme, { name: "README.txt" });
  archive.finalize();
}
