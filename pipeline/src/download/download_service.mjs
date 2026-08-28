// Ce qu'il faut rassembler pour utiliser un template hors de la pipeline :
// ses images réelles, son nom de composant, et son CSS Tailwind compilé.
// Ne touche jamais à la requête HTTP.

import fs from "fs";
import path from "path";
import { OUT_ROOT, TEMPLATES_ROOT, PIPELINE_ROOT } from "../shared/paths_shared.mjs";
import { compileTailwind } from "../rendering/compile_tailwind.mjs";


const IMAGE_IMPORT_RE = /@\/images\/cv-templates\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\.(?:png|jpe?g))/g;
// Les deux formes possibles : `export default function X(...)` ou une
// déclaration suivie de `export default X` en fin de fichier.
const COMPONENT_NAME_RE = /export\s+default\s+(?:function\s+)?(\w+)/;

/** Rassemble tout ce qu'il faut pour utiliser le composant généré ailleurs :
 * le .jsx final et les vraies images qu'il référence (déjà placées par
 * lib/pipeline.mjs dans templates copy/images/cv-templates/<slug>/). */
export function collectDownloadAssets(jsxPath) {
  const jsxCode = fs.readFileSync(jsxPath, "utf-8");
  const componentName = jsxCode.match(COMPONENT_NAME_RE)?.[1] || "TemplateHtml";
  const images = [];
  for (const [, slug, filename] of jsxCode.matchAll(IMAGE_IMPORT_RE)) {
    const abs = path.join(TEMPLATES_ROOT, "images", "cv-templates", slug, filename);
    if (fs.existsSync(abs)) images.push({ abs, zipPath: `images/cv-templates/${slug}/${filename}` });
  }
  return { jsxCode, componentName, images };
}

// CSS compilé AU MOMENT DU TÉLÉCHARGEMENT, pas à la génération : le
// template peut avoir été retouché dans l'éditeur visuel entre les deux, et
// un CSS compilé trop tôt n'aurait pas les classes ajoutées depuis.
//
// L'app ne compile plus rien pour ces templates -- le mécanisme qui
// scannait les templates en base pour alimenter le bundle Tailwind global a
// été supprimé. Chaque template doit donc arriver avec son CSS complet.
//
// Périmètre du scan : le composant et le MOTEUR seul. Scanner tout
// "templates copy" embarquerait les classes de l'exemple Visian, qui
// gonfleraient un css_source destiné à être injecté tel quel.
/** Renvoie le CSS Tailwind du template converti, ou une erreur explicite. */
export function compileTemplateCss(db) {
  if (db.error) return { css: null, error: null };
  const scanPath = path.join(OUT_ROOT, `.css-scan-${process.pid}-${Date.now()}.jsx`);
  try {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(scanPath, db.code);
    const out = compileTailwind({
      contentGlobs: `${scanPath},${TEMPLATES_ROOT}/engine/**/*.{jsx,js}`,
      inputCss: path.join(PIPELINE_ROOT, "src", "tailwind", "tailwind_db_input.css"),
      configPath: path.join(PIPELINE_ROOT, "src", "tailwind", "tailwind.db.config.cjs"),
    });
    return { css: out.css, error: out.error };
  } catch (err) {
    return { css: null, error: err.message };
  } finally {
    try { fs.unlinkSync(scanPath); } catch { /* fichier temporaire */ }
  }
}
