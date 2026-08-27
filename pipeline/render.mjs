// Compile un composant JSX (export default CvPage) avec esbuild, le monte
// dans une page headless via Puppeteer avec les cvData fournies, et
// screenshotte le résultat. Utilisé entre chaque passe pour donner à l'IA
// une image de son propre rendu.
//
// Usage: node render.mjs <jsxFile> <cvDataJsonFile> <outPngFile> [width] [height]

import { spawnSync } from "child_process";
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import { compileTailwind } from "./compile_tailwind.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , jsxFile, dataFile, outPng, widthArg, heightArg, bgFallbackFile] = process.argv;
if (!jsxFile || !dataFile || !outPng) {
  console.error("Usage: node render.mjs <jsxFile> <cvDataJsonFile> <outPngFile> [width] [height] [bgFallbackImage]");
  process.exit(1);
}

const width = parseInt(widthArg || "1240", 10);
const height = parseInt(heightArg || "1754", 10);
const jsxAbs = path.resolve(jsxFile);
const dataAbs = path.resolve(dataFile);

// Les templates réels (et le moteur de pagination universel fourni dans
// "templates copy/") utilisent des imports par alias `@/...` propres à
// l'app CV Smart, des assets image réels, et react-redux, qu'on n'a pas
// forcément ici. Priorité de résolution pour `@/images/...` :
//   1. le vrai fichier, si déposé dans templates copy/images/<même chemin>
//   2. l'image de référence passée en argument (le screenshot cible, pendant
//      un run de pipeline -- bien plus fidèle qu'un aplat gris)
//   3. un placeholder gris uni, en dernier recours
const TEMPLATES_ROOT = path.resolve(__dirname, "..", "templates copy");
const IMAGES_ROOT = path.join(TEMPLATES_ROOT, "images");
const PLACEHOLDER_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAATklEQVR4nO3NMQEAIRDEwPv4V0nxOmhZA6Fgx8B8a/1zA1fWaSzCzE6NNXhVaqzBq1JjDV6VGmvwqtRYg1elxhq8KjXW4FWpsQavmsfjDWL7AvoGT3VkAAAAAElFTkSuQmCC";

function fallbackImageDataUri() {
  if (bgFallbackFile && fs.existsSync(bgFallbackFile)) {
    const ext = path.extname(bgFallbackFile).slice(1) || "png";
    return `data:image/${ext};base64,${fs.readFileSync(bgFallbackFile).toString("base64")}`;
  }
  return PLACEHOLDER_IMAGE_DATA_URI;
}

const cvSmartAliasPlugin = {
  name: "cv-smart-aliases",
  setup(build) {
    build.onResolve({ filter: /^@\/components\/CvSmart\/templates\// }, (args) => {
      const rel = args.path.replace("@/components/CvSmart/templates/", "");
      const base = path.join(TEMPLATES_ROOT, rel);
      const candidate = [base, `${base}.jsx`, `${base}.js`].find((p) => fs.existsSync(p));
      if (candidate)
        return { path: candidate };
      // Un template généré peut référencer son propre CSS (ex:
      // regattaSmartCv.css) qui n'existe pas encore -- retombe sur un
      // module vide plutôt que d'échouer sur un fichier manquant.
      if (rel.endsWith(".css"))
        return { path: args.path, namespace: "cv-smart-empty-css-stub" };
      return { path: base };
    });
    build.onLoad({ filter: /.*/, namespace: "cv-smart-empty-css-stub" }, () => ({ contents: "", loader: "empty" }));

    build.onResolve({ filter: /^@\/images\// }, (args) => {
      const rel = args.path.replace("@/images/", "");
      const realPath = path.join(IMAGES_ROOT, rel);
      if (fs.existsSync(realPath))
        return { path: realPath };
      const outDirPath = path.join(path.dirname(jsxAbs), path.basename(args.path));
      if (fs.existsSync(outDirPath))
        return { path: outDirPath };
      return { path: args.path, namespace: "cv-smart-image-stub" };
    });
    build.onLoad({ filter: /.*/, namespace: "cv-smart-image-stub" }, (args) => ({
      contents: `export default ${JSON.stringify(fallbackImageDataUri())};`,
      loader: "js",
      resolveDir: path.dirname(args.path),
    }));

    // Étiquette chaque <img> du composant avec son NUMÉRO D'ORDRE dans le
    // fichier source (data-cvimg="0", "1", ...). C'est ce qui permet à
    // l'éditeur visuel de la preview de relier une image déplacée/redimensionnée
    // à la souris à la balise JSX exacte qui l'a produite, pour réécrire
    // ensuite le code -- sans ça, deux <img> partageant la même image
    // importée seraient indiscernables dans le DOM.
    // Comparaison sur le chemin RÉEL des deux côtés : esbuild résout les
    // liens symboliques (sur macOS /tmp pointe vers /private/tmp), donc une
    // comparaison de chaînes brutes raterait le fichier d'entrée.
    const realPath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const jsxReal = realPath(jsxAbs);
    build.onLoad({ filter: /\.jsx$/ }, (args) => {
      let contents = fs.readFileSync(args.path, "utf-8");
      if (realPath(args.path) === jsxReal) {
        let i = 0;
        contents = contents.replace(/<img\s/g, () => `<img data-cvimg="${i++}" `);
        // Blocs de texte, pour l'édition des marges intérieures/extérieures.
        // Le `[\s>]` exigé après le nom évite d'attraper <path> (SVG) ou
        // <link>, qui commencent par les mêmes lettres.
        let t = 0;
        contents = contents.replace(
          /<(p|h[1-6]|li|div)([\s>])/g,
          (_m, tag, after) => `<${tag} data-cvtext="${t++}"${after === ">" ? ">" : " "}`
        );
      } else if (/[\/\\]engine[\/\\]/.test(args.path)) {
        // Le moteur de pagination est du code PARTAGÉ : on ne le réécrira
        // jamais. Mais il rend des éléments (les titres de section) dont le
        // style vient d'une classe passée par le composant généré. On les
        // marque donc pour qu'ils soient sélectionnables : l'ajustement ira
        // modifier cette classe dans le composant, pas le moteur.
        contents = contents.replace(/<(p|h[1-6]|li|div)([\s>])/g,
          (_m, tag, after) => `<${tag} data-cvcls="1"${after === ">" ? ">" : " "}`);
      }
      return { contents, loader: "jsx" };
    });

    build.onResolve({ filter: /^react-redux$/ }, (args) => ({ path: args.path, namespace: "cv-smart-redux-stub" }));
    build.onLoad({ filter: /.*/, namespace: "cv-smart-redux-stub" }, () => ({
      contents: `
        const FAKE_STATE = { auth: { saleInfo: { email: "contact@example.com", phone_number: "+33 1 23 45 67 89" } } };
        export function useSelector(selector) { try { return selector(FAKE_STATE); } catch { return undefined; } }
        export function useDispatch() { return () => {}; }
      `,
      loader: "js",
    }));
  },
};


const sharedCssPath = path.join(TEMPLATES_ROOT, "visianSmartCv.css");
const sharedCss = fs.existsSync(sharedCssPath) ? fs.readFileSync(sharedCssPath, "utf-8") : "";

// Prop `assets` de l'aperçu : les images extraites du PDF, converties en
// data URL et indexées par les clés que le composant a déclarées dans
// `assets-map.json`. Sans ça, un composant qui lit `assets.page_bg`
// s'afficherait sans aucune image.
function buildAssets() {
  const mapFile = path.join(path.dirname(jsxAbs), "assets-map.json");
  if (!fs.existsSync(mapFile)) return {};
  let map;
  try {
    map = JSON.parse(fs.readFileSync(mapFile, "utf-8"));
  } catch {
    return {};
  }
  const out = {};
  for (const [key, index] of Object.entries(map)) {
    const file = path.join(path.dirname(jsxAbs), `extracted-${index}.png`);
    if (!fs.existsSync(file)) continue;
    out[key] = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  }
  return out;
}
const previewAssets = buildAssets();

const entryContents = `
import React from "react";
import { createRoot } from "react-dom/client";
import CvPage from ${JSON.stringify(jsxAbs)};
import cvData from ${JSON.stringify(dataAbs)};

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(CvPage, { cvData, assets: ${JSON.stringify(previewAssets)}, pageWidth: ${width}, pageHeight: ${height} }));
`;

const tmpEntry = path.join(path.dirname(jsxAbs), `.entry-${Date.now()}-${Math.random().toString(36).slice(2)}.jsx`);
fs.writeFileSync(tmpEntry, entryContents);

let bundle;
try {
  const result = await esbuild.build({
    entryPoints: [tmpEntry],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(__dirname, "node_modules")],
    loader: { ".css": "empty", ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".svg": "dataurl" },
    plugins: [cvSmartAliasPlugin],
  });
  bundle = result.outputFiles[0].text;
} finally {
  fs.unlinkSync(tmpEntry);
}

// On ne scanne QUE le composant rendu et le moteur partagé. Tailwind ne
// génère que les classes qu'il VOIT : un composant situé hors de out/
// (fichier temporaire, test ponctuel) se retrouvait rendu sans aucune de ses
// classes utilitaires, les images reprenant alors leur taille naturelle -- ce
// qui ressemble à un bug de mise en page. Scanner tout out/ faisait à
// l'inverse relire les JSX de chaque run précédent : compilation de plus en
// plus lente et CSS pollué par les classes des autres templates.
const { css: tailwindCss, error: tailwindError } = compileTailwind({
  contentGlobs: `${jsxAbs},${TEMPLATES_ROOT}/**/*.{jsx,js}`,
  inputCss: path.join(__dirname, "tailwind_input.css"),
});
if (tailwindError) console.error("TAILWIND_ERROR:" + tailwindError);
// Version du schéma d'étiquetage (data-cvimg / data-cvtext / data-cvcls).
// L'éditeur s'en sert pour savoir qu'un rendu ancien doit être refait :
// sans ce marqueur, un HTML produit avant l'ajout d'un type de repère
// laisserait l'édition correspondante silencieusement indisponible.
const CV_TAGS_VERSION = "4";

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="cv-tags" content="${CV_TAGS_VERSION}"><style>html,body{margin:0;padding:0;}${tailwindCss}\n${sharedCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;

// Page autonome (CSS + JS inline, aucune requête externe) -- ouvrable
// directement dans un navigateur pour voir le rendu live, pas juste une
// capture figée.
const outHtml = outPng.replace(/\.png$/i, ".html");
fs.writeFileSync(outHtml, html);

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 150));
  const root = await page.$("#root");
  await root.screenshot({ path: outPng });

  // Captures PAR PAGE, en plus de la capture globale : quand on reproduit un
  // template entier, la passe 2 doit comparer la page N du rendu à la page N
  // de la cible, ce que la capture empilée (toutes les pages + les gouttières
  // entre elles) ne permet pas -- le diff pixelmatch exige des dimensions
  // identiques. Les vraies pages sont les enfants directs du conteneur qui
  // occupent toute sa largeur : le moteur de pagination monte aussi un noeud
  // de mesure caché, plus étroit, qu'il ne faut pas confondre avec une page.
  const pageCount = await page.evaluate(() => {
    const comp = document.querySelector("#root")?.firstElementChild;
    if (!comp) return 0;
    const full = comp.getBoundingClientRect().width;
    let n = 0;
    for (const child of comp.children) {
      if (Math.abs(child.getBoundingClientRect().width - full) > 2) continue;
      child.setAttribute("data-cv-page", String(++n));
    }
    return n;
  });
  for (let i = 1; i <= pageCount; i++) {
    const el = await page.$(`[data-cv-page="${i}"]`);
    if (!el) continue;
    const pagePng = outPng.replace(/\.png$/i, `-page-${i}.png`);
    await el.screenshot({ path: pagePng });
    console.log("PAGE_RENDER:" + i + ":" + pagePng);
  }
  console.log("PAGE_COUNT:" + pageCount);
  if (errors.length) {
    console.error("RENDER_ERRORS:" + JSON.stringify(errors));
  }
} finally {
  await browser.close();
}
console.log("RENDERED:" + outPng);
console.log("PREVIEW:" + outHtml);
