// Échappement du texte inséré dans le HTML généré.

/** Les messages de la pipeline peuvent contenir des extraits de code ou de
 * stack trace : sans échappement, un `<` suffit à casser la page. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
