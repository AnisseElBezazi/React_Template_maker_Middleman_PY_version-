import { LOGO } from "./components/icons_view.mjs";

/** Coquille commune aux trois écrans : barre d'outils, rail de gauche, plan de
 * travail au centre, panneau d'inspection à droite. Le châssis est clair et
 * c'est le plan de travail qui est légèrement plus gris -- les documents
 * comparés étant blancs, ils s'en détachent par leur ombre portée. */
export function layout(title, { crumb = "", status = "", actions = "", rail = "", main = "", inspector = "", script = "" }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Crect x='1' y='1' width='10.5' height='10.5' rx='2' fill='%23b0b0b0'/%3E%3Crect x='6.25' y='6.25' width='10.75' height='10.75' rx='2.25' fill='none' stroke='%230d99ff' stroke-width='1.5'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <header class="toolbar">
    <div class="brand">${LOGO}<b>Design-to-Code</b></div>
    ${crumb ? `<div class="tb-sep"></div><nav class="crumb">${crumb}</nav>` : ""}
    <div class="tb-right">${status}${actions}</div>
  </header>
  <div class="workbench">
    <aside class="rail">${rail}</aside>
    ${main}
    ${inspector}
  </div>
  ${script}
</body></html>`;
}
