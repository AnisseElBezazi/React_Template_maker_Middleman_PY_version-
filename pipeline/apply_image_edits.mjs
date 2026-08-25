// Applique dans le JSX les ajustements d'images faits à la souris dans la
// preview (éditeur type Figma : déplacer / redimensionner).
//
// Pourquoi réécrire le className plutôt qu'ajouter un style inline : le
// composant est responsive (tout est en `em` relatif à une police racine
// calculée depuis la largeur du conteneur). Un style inline en pixels
// casserait cette mise à l'échelle, et un second prop `style` écraserait
// silencieusement celui d'origine (perdant par exemple un `transform:
// rotate(...)`). On retire donc uniquement les utilitaires de position/taille
// en conflit, et on ajoute les nouvelles valeurs en `em`.
//
// Usage CLI (test local) : node apply_image_edits.mjs <in.jsx> <edits.json> <out.jsx>

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** Trouve l'étendue exacte de la Nième balise <img ...> du source, en
 * suivant l'imbrication des accolades JSX et les chaînes, pour ne pas
 * s'arrêter sur un `>` qui appartiendrait à une expression interne. */
function findImgTagSpan(source, index) {
  return findTagSpan(source, /<img\s/g, index);
}

// Mêmes balises, dans le même ordre, que l'étiquetage fait au rendu
// (render.mjs) -- c'est ce qui garantit que l'index reçu de l'éditeur
// désigne bien la même balise dans le source.
const TEXT_TAG_RE = /<(p|h[1-6]|li|div)([\s>])/g;

function findTagSpan(source, re, index) {
  re.lastIndex = 0;
  let match;
  let n = 0;
  while ((match = re.exec(source)) !== null) {
    if (n++ !== index) continue;
    const start = match.index;
    let depth = 0;
    let quote = null;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) return { start, end: i + 1 };
    }
    return null;
  }
  return null;
}

// Utilitaires Tailwind de position/taille qu'un déplacement ou un
// redimensionnement rend obsolètes -- on les retire pour éviter deux règles
// contradictoires sur la même propriété (l'ordre de sortie de Tailwind
// déciderait alors du gagnant, ce qui est imprévisible).
// Le `-?` initial couvre les utilitaires négatifs (`-right-[8%]`,
// `-bottom-[0.3em]`), qui sinon survivraient à un déplacement et
// entreraient en conflit avec la nouvelle position.
const CONFLICTING = new RegExp(
  "^-?(?:" +
    "(?:left|right|top|bottom|inset|inset-x|inset-y)-(?:\\[[^\\]]*\\]|auto|full|\\d+(?:\\.\\d+)?|px)" +
    "|(?:w|h)-(?:\\[[^\\]]*\\]|full|auto|screen|px|\\d+(?:\\.\\d+)?)" +
    ")$"
);

function cleanClassName(className, { move }) {
  const kept = className
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => {
      if (!CONFLICTING.test(c)) return true;
      // En redimensionnement seul, on ne touche pas au positionnement.
      if (!move && /^-?(?:left|right|top|bottom|inset)/.test(c)) return true;
      return false;
    });
  return kept;
}

/** Fin de l'objet littéral d'un `style={{ ... }}` : on compte les accolades
 * pour retrouver la fermeture réelle, un style pouvant contenir des objets
 * ou des expressions imbriqués. */
function findStyleObjectEnd(tag, fromIndex) {
  let depth = 0;
  for (let i = fromIndex; i < tag.length; i++) {
    const c = tag[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i; // ferme le `{` de l'objet littéral
    }
  }
  return -1;
}

/** Les valeurs à écrire, en `em`, sous forme de paires JS. */
function overrideProps(edit, move) {
  const props = [];
  if (move) {
    props.push(`position: 'absolute'`, `left: '${edit.left}em'`, `top: '${edit.top}em'`, `right: 'auto'`, `bottom: 'auto'`);
  }
  if (edit.width != null) props.push(`width: '${edit.width}em'`);
  if (edit.height != null) props.push(`height: '${edit.height}em'`);
  if (props.length) props.push(`maxWidth: 'none'`);
  return props;
}

/** Fusionne des propriétés CSS dans le `style` inline d'une balise. */
function mergeStyle(tag, props) {
  if (!props.length) return tag;
  const styleStart = tag.search(/style=\{\{/);
  if (styleStart !== -1) {
    const objOpen = tag.indexOf("{", styleStart + "style=".length) + 1;
    const objEnd = findStyleObjectEnd(tag, objOpen);
    if (objEnd !== -1) {
      const inner = tag.slice(objOpen + 1, objEnd).trim();
      const merged = inner ? `${inner.replace(/,\s*$/, "")}, ${props.join(", ")}` : props.join(", ");
      return tag.slice(0, objOpen + 1) + ` ${merged} ` + tag.slice(objEnd);
    }
  }
  return tag.replace(/^<(\w+)/, (m, t) => `<${t} style={{ ${props.join(", ")} }}`);
}

/** Marges (intérieures/extérieures) ajustées à la souris sur les blocs de
 * texte. Comme pour les images, on écrit dans le `style` inline : il prime
 * sur les classes utilitaires déjà présentes (px-[...], mb-[...]). */
export function applyTextEdits(jsxSource, textEdits) {
  let source = jsxSource;
  const applied = [];
  const indexes = Object.keys(textEdits).map(Number).sort((a, b) => b - a);

  for (const index of indexes) {
    const props = Object.entries(textEdits[index])
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: '${v}em'`);
    if (!props.length) continue;

    const span = findTagSpan(source, TEXT_TAG_RE, index);
    if (!span) continue;
    const tag = source.slice(span.start, span.end);
    source = source.slice(0, span.start) + mergeStyle(tag, props) + source.slice(span.end);
    applied.push(index);
  }
  return { source, applied };
}

export function applyImageEdits(jsxSource, edits) {
  let source = jsxSource;
  const applied = [];

  // De la fin vers le début : patcher une balise décale tout ce qui suit,
  // donc on traite les index décroissants pour garder les positions valides.
  const indexes = Object.keys(edits)
    .map(Number)
    .sort((a, b) => b - a);

  for (const index of indexes) {
    const edit = edits[index];
    const span = findImgTagSpan(source, index);
    if (!span) continue;

    const tag = source.slice(span.start, span.end);
    const classMatch = tag.match(/className="([^"]*)"/);
    const move = edit.left != null && edit.top != null;

    // On retire d'abord les utilitaires Tailwind devenus contradictoires,
    // puis on écrit les valeurs dans le `style` inline : c'est lui qui prime
    // sur les classes, et beaucoup de composants générés dimensionnent déjà
    // leurs images par un style calculé en JS -- ne réécrire que le
    // className resterait alors sans aucun effet visible.
    let newTag = tag;
    if (classMatch) {
      newTag = newTag.replace(/className="[^"]*"/, `className="${cleanClassName(classMatch[1], { move }).join(" ")}"`);
    }

    const props = overrideProps(edit, move);
    const styleStart = newTag.search(/style=\{\{/);
    if (styleStart !== -1) {
      const objOpen = newTag.indexOf("{", styleStart + "style=".length) + 1;
      const objEnd = findStyleObjectEnd(newTag, objOpen);
      if (objEnd !== -1) {
        const inner = newTag.slice(objOpen + 1, objEnd).trim();
        const merged = inner ? `${inner.replace(/,\s*$/, "")}, ${props.join(", ")}` : props.join(", ");
        newTag = newTag.slice(0, objOpen + 1) + ` ${merged} ` + newTag.slice(objEnd);
      }
    } else {
      newTag = newTag.replace(/^<img\s/, `<img style={{ ${props.join(", ")} }} `);
    }

    source = source.slice(0, span.start) + newTag + source.slice(span.end);
    applied.push(index);
  }

  return { source, applied };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const [, , inPath, editsPath, outPath] = process.argv;
  const edits = JSON.parse(fs.readFileSync(editsPath, "utf-8"));
  const { source, applied } = applyImageEdits(fs.readFileSync(inPath, "utf-8"), edits);
  fs.writeFileSync(outPath, source);
  console.log(JSON.stringify({ applied }));
}

// --- Ajustements portant sur une CLASSE ---------------------------------
// Les titres de section sont rendus par le moteur de pagination, du code
// partagé qu'on ne modifie jamais. Leur style vient d'une chaîne de classes
// que le composant généré passe au moteur : c'est donc cette chaîne, dans le
// composant, qu'il faut corriger.

// Un raccourci comme `px-[0.7em]` couvre deux côtés : le retirer pour n'en
// changer qu'un remettrait l'autre à zéro. On développe donc d'abord tous les
// espacements en valeurs par côté, on applique les modifications, puis on
// réécrit des utilitaires explicites côté par côté.
const EXPAND = {
  p: ["pt", "pr", "pb", "pl"], px: ["pl", "pr"], py: ["pt", "pb"],
  pt: ["pt"], pr: ["pr"], pb: ["pb"], pl: ["pl"],
  m: ["mt", "mr", "mb", "ml"], mx: ["ml", "mr"], my: ["mt", "mb"],
  mt: ["mt"], mr: ["mr"], mb: ["mb"], ml: ["ml"],
};
const PROP_TO_UTIL = {
  paddingTop: "pt", paddingRight: "pr", paddingBottom: "pb", paddingLeft: "pl",
  marginTop: "mt", marginRight: "mr", marginBottom: "mb", marginLeft: "ml",
};

/** Réécrit une chaîne de classes utilitaires en y imposant les espacements
 * demandés, sans perdre ceux des côtés qu'on ne touche pas. */
export function rewriteSpacingClasses(className, spacing) {
  const sides = {};
  const kept = [];

  for (const c of className.split(/\s+/).filter(Boolean)) {
    const m = c.match(/^(-?)([a-z]{1,2})-(.+)$/);
    const targets = m && EXPAND[m[2]];
    if (!targets) {
      kept.push(c);
      continue;
    }
    for (const side of targets) sides[side] = m[1] + m[3]; // la dernière déclaration l'emporte
  }

  for (const [prop, em] of Object.entries(spacing)) {
    if (em == null) continue;
    sides[PROP_TO_UTIL[prop]] = `[${em}em]`;
  }

  for (const [side, value] of Object.entries(sides)) {
    const neg = value.startsWith("-");
    kept.push(`${neg ? "-" : ""}${side}-${neg ? value.slice(1) : value}`);
  }
  return kept.join(" ");
}

export function applyClassEdits(jsxSource, classEdits) {
  let source = jsxSource;
  const applied = [];
  for (const [className, spacing] of Object.entries(classEdits)) {
    if (!className || !Object.keys(spacing).length) continue;
    const next = rewriteSpacingClasses(className, spacing);
    // La chaîne apparaît telle quelle dans le composant (constante ou
    // attribut) : on la remplace partout où elle est écrite littéralement.
    if (!source.includes(className)) continue;
    source = source.split(className).join(next);
    applied.push(className);
  }
  return { source, applied };
}
