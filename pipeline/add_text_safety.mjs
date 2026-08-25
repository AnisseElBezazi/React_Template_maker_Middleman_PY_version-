// Sécurité de débordement de texte -- purement ALGORITHMIQUE (aucun appel LLM).
//
// Deux défauts distincts se combinent sur les templates générés, et il faut
// LES DEUX classes pour être à l'abri (vérifié empiriquement) :
//
// 1. La BOÎTE sort de son parent. Dans un conteneur `flex flex-col
//    items-center` (ou items-start/end), l'enfant est dimensionné sur son
//    CONTENU sur l'axe transverse et n'est pas borné par la largeur du
//    parent : un <p> de 389px se retrouve dans un parent de 329px.
//    -> corrigé par `max-w-full`.
// 2. Le TEXTE sort de sa boîte. Une chaîne sans espace (email, URL, mot
//    très long) n'a aucune opportunité de césure : le CSS n'a pas le droit
//    de la couper, donc il la laisse dépasser.
//    -> corrigé par `break-words` (overflow-wrap: break-word).
//
// `max-w-full` n'est PAS appliqué aux <div> : une bannière pleine largeur
// jouant sur des marges négatives serait rognée. Les div ne reçoivent que
// `break-words`, qui ne contraint aucune largeur.

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);
const WRAP_ONLY_TAGS = new Set(["div", "span", "a", "td", "th"]);

// Trouve le `>` qui ferme réellement la balise ouvrante commençant à `start`,
// en ignorant ceux qui vivent dans une chaîne ou dans une expression {...}
// (ex: `onClick={() => ...}`, `className={a > b ? x : y}`).
function findTagEnd(src, start) {
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (c === ">" && depth === 0) return i;
  }
  return -1;
}

export function addTextSafety(jsx) {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/g;
  const edits = [];
  let m;

  while ((m = tagRe.exec(jsx)) !== null) {
    const tag = m[1].toLowerCase();
    const isBlock = BLOCK_TAGS.has(tag);
    if (!isBlock && !WRAP_ONLY_TAGS.has(tag)) continue;

    const end = findTagEnd(jsx, m.index + m[0].length);
    if (end === -1) continue;
    const attrs = jsx.slice(m.index + m[0].length, end);

    // className={...} (expression) : on ne sait pas réécrire sans risque.
    if (/className=\{/.test(attrs)) continue;

    const clsMatch = attrs.match(/className="([^"]*)"/);
    const cls = clsMatch ? clsMatch[1] : "";
    const has = (c) => new RegExp(`(^|\\s)${c}(\\s|$)`).test(cls);

    // `truncate` / `whitespace-nowrap` = volonté explicite de ne pas revenir
    // à la ligne : on ne la contrarie pas. (truncate a en revanche BESOIN
    // d'une largeur bornée pour fonctionner, donc max-w-full reste utile.)
    const noWrapWanted = has("truncate") || has("whitespace-nowrap");

    const add = [];
    if (isBlock && !has("max-w-full") && !/(^|\s)max-w-/.test(cls)) add.push("max-w-full");
    if (!noWrapWanted && !has("break-words") && !has("break-all")) add.push("break-words");
    if (!add.length) continue;

    if (clsMatch) {
      const at = m.index + m[0].length + attrs.indexOf(clsMatch[0]);
      edits.push({ start: at, end: at + clsMatch[0].length, text: `className="${(cls + " " + add.join(" ")).trim()}"` });
    } else {
      const at = m.index + m[0].length;
      edits.push({ start: at, end: at, text: ` className="${add.join(" ")}"` });
    }
  }

  // Application à rebours pour ne pas décaler les index suivants.
  let out = jsx;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { jsx: out, count: edits.length };
}
