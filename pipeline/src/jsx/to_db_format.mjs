// Convertit un composant généré (format preview : imports ES) vers le format
// attendu par l'app CV Smart, où le fichier est ÉVALUÉ comme un corps de
// fonction recevant `React` et `engine`, et où les images viennent de la base
// via un objet `assets`.
//
// Pourquoi les images passent en portée module plutôt qu'en prop : ce sont
// des assets de TEMPLATE (un fond de page ne change pas d'un candidat à
// l'autre), pas des données de CV. Les faire descendre en prop obligerait à
// réécrire la signature de chaque sous-composant qui affiche une image --
// une transformation qui marche sur les cas simples et casse en silence
// ailleurs. Une constante de module est ici correcte et robuste.
//
// Usage CLI : node to_db_format.mjs <in.jsx> [out.jsx]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const IMAGE_IMPORT = /^import\s+(\w+)\s+from\s+['"]@\/images\/([^'"]+)['"];?\s*$/gm;
const ANY_IMPORT = /^import\s+.*?from\s+['"][^'"]+['"];?\s*$|^import\s+['"][^'"]+['"];?\s*$/gm;

const REACT_SYMBOLS = ["useLayoutEffect", "useEffect", "useRef", "useState", "useMemo", "useCallback", "Fragment"];
const ENGINE_SYMBOLS = ["splitEntryIntoFragments", "PaginatedEntryPages", "usePaginatedGroups", "paginationEngine", "entryFragments"];

const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();

export function toDbFormat(source) {
  const assets = [];
  for (const m of source.matchAll(IMAGE_IMPORT)) {
    assets.push({ varName: m[1], key: snake(m[1]), file: m[2] });
  }

  let code = source.replace(ANY_IMPORT, "").replace(/^\s*\n/, "");

  // Les images arrivent désormais par la prop `assets`, transmise
  // explicitement à chaque sous-composant : plus rien à réécrire ici. Un
  // import d'image résiduel (ancien format) est encore converti, mais vers
  // la prop et non vers une variable de module -- celle-ci n'était ni sûre
  // avec un module mis en cache, ni réactive.
  for (const a of assets) {
    code = code.replace(new RegExp(`\\b${a.varName}\\b`, "g"), `assets.${a.key}`);
  }

  // `export default function X(...)` -> `function X(...)`, et on renvoie le
  // composant en fin de fichier comme l'attend l'évaluateur.
  let componentName = null;
  const defaultFn = code.match(/export\s+default\s+function\s+(\w+)/);
  const defaultRef = code.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
  if (defaultFn) {
    componentName = defaultFn[1];
    code = code.replace(/export\s+default\s+function/, "function");
  } else if (defaultRef) {
    componentName = defaultRef[1];
    code = code.replace(/export\s+default\s+\w+\s*;?\s*$/m, "");
  } else {
    throw new Error("Composant introuvable : aucun `export default` dans le fichier.");
  }

  // Le composant accepte `assets` et le publie en portée module, avant que
  // React ne rende ses enfants -- qui peuvent donc l'utiliser sans le recevoir.
  const sigRe = new RegExp(`function\\s+${componentName}\\s*\\(\\s*\\{([^}]*)\\}\\s*\\)\\s*\\{`);
  if (sigRe.test(code)) {
    code = code.replace(sigRe, (m, props) => {
      const list = props.trim().replace(/,\s*$/, "");
      return `function ${componentName}({ ${list}${/\bassets\b/.test(list) ? "" : ", assets"} }) {\n`;
    });
  }

  const used = (names) => names.filter((n) => new RegExp(`\\b${n}\\b`).test(code));
  const reactUsed = used(REACT_SYMBOLS);
  const engineUsed = used(ENGINE_SYMBOLS);

  const header = [
    reactUsed.length ? `const { ${reactUsed.join(", ")} } = React` : null,
    engineUsed.length ? `const { ${engineUsed.join(", ")} } = engine` : null,
    null,
  ].filter(Boolean).join("\n");

  return {
    code: `${header}\n\n${code.trim()}\n\nreturn ${componentName}\n`,
    assets,
    componentName,
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const { code, assets, componentName } = toDbFormat(fs.readFileSync(process.argv[2], "utf-8"));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], code);
  else console.log(code);
  console.error(`composant: ${componentName} | assets: ${assets.map((a) => `${a.key} <- ${a.file}`).join(", ")}`);
}
