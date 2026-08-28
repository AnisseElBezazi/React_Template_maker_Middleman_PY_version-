// Bundler JSX pur -- AUCUNE orchestration ici. Appelé en sous-processus par
// le backend Python, exactement comme celui-ci appelle déjà pdftoppm ou
// tailwindcss : esbuild reste un outil externe, pas de la logique métier.
//
// Usage: node esbuild_bundle.mjs <config.json> <outBundle.js>
// config.json : { jsxFile, dataFile, assets, width, height, bgFallbackFile }
// assets vient déjà construit (lecture d'assets-map.json faite côté Python).

import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES_ROOT = path.resolve(PIPELINE_ROOT, "..", "templates copy");
const IMAGES_ROOT = path.join(TEMPLATES_ROOT, "images");
const PLACEHOLDER_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAATklEQVR4nO3NMQEAIRDEwPv4V0nxOmhZA6Fgx8B8a/1zA1fWaSzCzE6NNXhVaqzBq1JjDV6VGmvwqtRYg1elxhq8KjXW4FWpsQavmsfjDWL7AvoGT3VkAAAAAElFTkSuQmCC";

const [, , configFile, outBundle] = process.argv;
if (!configFile || !outBundle) {
  console.error("Usage: node esbuild_bundle.mjs <config.json> <outBundle.js>");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
const jsxAbs = path.resolve(config.jsxFile);
const dataAbs = path.resolve(config.dataFile);
const width = config.width || 1240;
const height = config.height || 1754;
const bgFallbackFile = config.bgFallbackFile || null;
const previewAssets = config.assets || {};

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

    const realPath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const jsxReal = realPath(jsxAbs);
    build.onLoad({ filter: /\.jsx$/ }, (args) => {
      let contents = fs.readFileSync(args.path, "utf-8");
      if (realPath(args.path) === jsxReal) {
        let i = 0;
        contents = contents.replace(/<img\s/g, () => `<img data-cvimg="${i++}" `);
        let t = 0;
        contents = contents.replace(
          /<(p|h[1-6]|li|div)([\s>])/g,
          (_m, tag, after) => `<${tag} data-cvtext="${t++}"${after === ">" ? ">" : " "}`
        );
      } else if (/[\/\\]engine[\/\\]/.test(args.path)) {
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

try {
  const result = await esbuild.build({
    entryPoints: [tmpEntry],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(PIPELINE_ROOT, "node_modules")],
    loader: { ".css": "empty", ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".svg": "dataurl" },
    plugins: [cvSmartAliasPlugin],
  });
  fs.writeFileSync(outBundle, result.outputFiles[0].text);
} finally {
  fs.unlinkSync(tmpEntry);
}
console.log("BUNDLED:" + outBundle);
