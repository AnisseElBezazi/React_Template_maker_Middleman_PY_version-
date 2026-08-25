// Interface web locale pour la pipeline Design-to-Code : glisser-déposer un
// PDF, suivi de la génération, puis comparaison PDF cible / preview React
// live côte à côte.
//
// Usage: node server.mjs  (puis ouvrir http://localhost:5050)

import "dotenv/config";
import { ZipArchive } from "archiver";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runPipeline } from "./lib/pipeline.mjs";
import { applyImageEdits, applyTextEdits, applyClassEdits } from "./apply_image_edits.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, "out");
const UPLOADS_ROOT = path.join(__dirname, "uploads");
const TEMPLATES_ROOT = path.resolve(__dirname, "..", "templates copy");
fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_ROOT,
    filename: (_req, file, cb) => {
      const ext = file.fieldname === "extraConfig" ? ".json" : ".pdf";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
});
const app = express();
app.use("/out", express.static(OUT_ROOT));
app.use("/uploads", express.static(UPLOADS_ROOT));

/** @type {Map<string, {status: string, step: string, message: string, log: {step:string,message:string}[], result: any, error: string|null, pdfUrl: string, page: number}>} */
const runs = new Map();
runs.set("1787999999999-demo1", { status: "running", step: "pass2", message: "Diff pixelmatch : 12.4% de pixels différents.", log: [{ step: "extract", message: "Génération du screenshot cible et du dictionnaire HTML (page 1)..." },{ step: "extract", message: "Fond détecté : 3 images extraites." },{ step: "pass1", message: "Appel à Claude..." },{ step: "pass1", message: "Rendu de la tentative 1..." },{ step: "pass1", message: "OK" },{ step: "pass2", message: "Génération de la grille de repères et de l'image de différence..." },{ step: "pass2", message: "Diff pixelmatch : 12.4% de pixels différents." }], stream: { step: "pass2", kind: "thinking", text: "Le bloc d'en-tête est décalé de 14 px vers le bas par rapport à la cible.\nLe trigramme est en #00ffa3 dans les deux rendus, donc la couleur est bonne.\nLe filigrane latéral déborde de 6 px à gauche : la rotation de -90deg est appliquée avant le positionnement, il faut compenser sur `left`.\n\nJe corrige d'abord le padding-top du conteneur, puis la position du filigrane." }, result: null, error: null, pdfUrl: null, page: 1 });
runs.set("1787999999998-demo2", { status: "error", step: "pass1", message: "", log: [], stream: { step: null, kind: null, text: "" }, result: null, error: "Le modèle a renvoyé un JSX qui ne compile pas :\n  SyntaxError: Unexpected token (48:12)\n  46 |   <div className=\"flex\">\n> 48 |     <p className={SECTION_BAR>Certifications</p>", pdfUrl: null, page: 1 });


function toPublicUrl(absPath) {
  return "/out/" + path.relative(OUT_ROOT, absPath).split(path.sep).join("/");
}

const PASS_LABELS = {
  attempt1: "Passe 1 -- premier jet",
  attempt2: "Passe 2 -- diff visuel",
  attempt3: "Passe 3 -- audit",
  final: "Passe 4+5 -- corrections de taille",
};

/** Les runs vivent en mémoire et disparaissent au redémarrage du serveur,
 * alors que tous leurs fichiers restent sur le disque. On reconstruit donc
 * un état minimal à partir du dossier du run, pour pouvoir rouvrir un
 * ancien résultat (et y retoucher les images) sans relancer de génération
 * payante. */
function rehydrateRun(runId) {
  const outDir = path.join(OUT_ROOT, runId);
  if (!fs.existsSync(outDir)) return null;

  const meta = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(outDir, "run-meta.json"), "utf-8"));
    } catch {
      return {};
    }
  })();

  const passes = [];
  for (const name of ["attempt1", "attempt2", "attempt3", "final"]) {
    const jsxPath = path.join(outDir, `${name}.jsx`);
    const pngPath = path.join(outDir, `${name}.png`);
    if (fs.existsSync(jsxPath) && fs.existsSync(pngPath)) {
      passes.push({ name, label: PASS_LABELS[name], jsxPath, pngPath, htmlPath: path.join(outDir, `${name}.html`) });
    }
  }
  if (!passes.length) return null;

  // Le PDF d'origine peut avoir été supprimé du dossier uploads ; la capture
  // cible, elle, vit dans le dossier du run et suffit pour comparer.
  const target = fs.readdirSync(outDir).find((f) => /^target-\d+\.png$/.test(f));
  let { width, height } = meta;
  if ((!width || !height) && target) {
    const buf = fs.readFileSync(path.join(outDir, target));
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  }
  const targetUrl = target ? toPublicUrl(path.join(outDir, target)) : null;

  return {
    status: "done",
    step: "done",
    message: "Rechargé depuis le disque.",
    log: [],
    error: null,
    restored: true,
    pdfUrl: meta.pdfUrl && fs.existsSync(path.join(UPLOADS_ROOT, path.basename(meta.pdfUrl))) ? meta.pdfUrl : null,
    targetUrl,
    page: meta.page || 1,
    result: { outDir, width, height, passes, ...meta.tokens },
  };
}

/** Récupère un run, depuis la mémoire ou, à défaut, depuis le disque. */
function getRun(runId) {
  return runs.get(runId) || rehydrateRun(runId);
}

const IMAGE_IMPORT_RE = /@\/images\/cv-templates\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\.(?:png|jpe?g))/g;
const COMPONENT_NAME_RE = /export default function (\w+)/;

/** Rassemble tout ce qu'il faut pour utiliser le composant généré ailleurs :
 * le .jsx final et les vraies images qu'il référence (déjà placées par
 * lib/pipeline.mjs dans templates copy/images/cv-templates/<slug>/). */
function collectDownloadAssets(jsxPath) {
  const jsxCode = fs.readFileSync(jsxPath, "utf-8");
  const componentName = jsxCode.match(COMPONENT_NAME_RE)?.[1] || "TemplateHtml";
  const images = [];
  for (const [, slug, filename] of jsxCode.matchAll(IMAGE_IMPORT_RE)) {
    const abs = path.join(TEMPLATES_ROOT, "images", "cv-templates", slug, filename);
    if (fs.existsSync(abs)) images.push({ abs, zipPath: `images/cv-templates/${slug}/${filename}` });
  }
  return { jsxCode, componentName, images };
}

/** Marque de l'outil : deux artboards décalés -- la cible et la preview,
 * séparées exactement par l'écart qu'on cherche à annuler. */
const LOGO = `<svg class="logo" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="10.5" height="10.5" rx="2" fill="#b0b0b0"/>
  <rect x="6.25" y="6.25" width="10.75" height="10.75" rx="2.25" stroke="#0d99ff" stroke-width="1.5"/>
</svg>`;

const ICON = {
  back: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.5L9 1.75Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8.75 2v3.25H12" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3.4v9.2a.5.5 0 0 0 .77.42l7-4.6a.5.5 0 0 0 0-.84l-7-4.6A.5.5 0 0 0 5 3.4Z" fill="currentColor"/></svg>`,
  cursor: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 2.4 12.6 7l-4 1.6L7 12.6 3.2 2.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v7.5m0 0L5.25 7.25M8 10l2.75-2.75M3 12.25h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  layers: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75 1.75 5 8 8.25 14.25 5 8 1.75Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m1.75 8.75 6.25 3.25 6.25-3.25" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  think: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><circle cx="5.2" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="10.8" cy="8" r="1" fill="currentColor"/></svg>`,
  write: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.4 2.6 13.4 5.6 5.9 13.1l-3.4.4.4-3.4 7.5-7.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  warn: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.25 14.5 13.5h-13L8 2.25Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.5v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.25H2.25V6M10 2.25h3.75V6M6 13.75H2.25V10M10 13.75h3.75V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pdf: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.75h-5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.25L9.5 1.75Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.25 2v2.5h2.75" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.75 11.25h4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

/** Coquille commune aux trois écrans : barre d'outils, rail de gauche, plan de
 * travail au centre, panneau d'inspection à droite. Le châssis est clair et
 * c'est le plan de travail qui est légèrement plus gris -- les documents
 * comparés étant blancs, ils s'en détachent par leur ombre portée. */
function layout(title, { crumb = "", status = "", actions = "", rail = "", main = "", inspector = "", script = "" }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Crect x='1' y='1' width='10.5' height='10.5' rx='2' fill='%23b0b0b0'/%3E%3Crect x='6.25' y='6.25' width='10.75' height='10.75' rx='2.25' fill='none' stroke='%230d99ff' stroke-width='1.5'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#ffffff; --bg-2:#fafafa; --hover:#f2f2f2; --active:#e9e9e9;
    --line:#e6e6e6; --line-2:#d9d9d9;
    --canvas:#f0f0f0; --canvas-dot:#dcdcdc;
    --tx:#1e1e1e; --tx-2:#5c5c5c; --tx-3:#767676;
    --sel:#0d99ff; --sel-tx:#0b7ac0; --sel-soft:rgba(13,153,255,.10);
    --ok:#14ae5c; --ok-tx:#0f8a4d; --warn:#ffcd29; --warn-tx:#8a6100;
    --bad:#f24822; --bad-tx:#c3341b;
    --r:4px; --r-lg:6px;
    --ui:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
    --shadow-sheet:0 1px 2px rgba(0,0,0,.07), 0 8px 24px rgba(0,0,0,.07);
    --shadow-pop:0 2px 6px rgba(0,0,0,.10), 0 12px 32px rgba(0,0,0,.14);
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--tx);
    font-family:var(--ui); font-size:12px; line-height:1.5;
    -webkit-font-smoothing:antialiased; letter-spacing:-0.006em;
    display:grid; grid-template-rows:40px minmax(0,1fr); overflow:hidden;
  }
  a { color:var(--sel-tx); text-decoration:none; }
  a:hover { text-decoration:underline; }
  button, input, textarea, select { font:inherit; letter-spacing:inherit; }
  :focus-visible { outline:2px solid var(--sel); outline-offset:1px; border-radius:2px; }
  ::selection { background:var(--sel-soft); }

  /* ---------- Barre d'outils ---------- */
  .toolbar {
    display:flex; align-items:center; gap:10px; padding:0 10px 0 12px;
    background:var(--bg); border-bottom:1px solid var(--line); min-width:0; z-index:20;
  }
  .toolbar .logo { flex:none; display:block; }
  .brand { display:flex; align-items:center; gap:8px; flex:none; }
  .brand b { font-size:12px; font-weight:600; letter-spacing:-0.012em; }
  .tb-sep { width:1px; height:18px; background:var(--line); flex:none; }
  .crumb { display:flex; align-items:center; gap:8px; min-width:0; color:var(--tx-3); font-size:11.5px; }
  .crumb .cur { color:var(--tx-2); }
  .tb-right { margin-left:auto; display:flex; align-items:center; gap:8px; flex:none; }

  .idchip {
    font-family:var(--mono); font-size:10.5px; color:var(--tx-3);
    background:var(--hover); border-radius:3px; padding:2px 6px;
    overflow-wrap:anywhere; max-width:230px;
  }

  /* ---------- Boutons ---------- */
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    height:28px; padding:0 10px; border-radius:var(--r); cursor:pointer;
    background:var(--hover); color:var(--tx); border:1px solid transparent;
    font-size:11.5px; font-weight:500; white-space:nowrap;
    transition:background .14s ease, border-color .14s ease, color .14s ease;
  }
  .btn:hover { background:var(--active); text-decoration:none; }
  .btn svg { flex:none; }
  .btn.primary { background:var(--sel); color:#fff; }
  .btn.primary:hover { background:#0b86e0; }
  .btn.ghost { background:transparent; color:var(--tx-2); }
  .btn.ghost:hover { background:var(--hover); color:var(--tx); }
  .btn.active { background:var(--sel-soft); color:var(--sel-tx); border-color:var(--sel); }
  .btn:disabled { background:var(--hover); color:#adadad; cursor:not-allowed; }
  .btn.primary:disabled { background:#e9e9e9; color:#a3a3a3; }
  .btn.icon { width:28px; padding:0; }
  .btn.outline { background:#fff; border-color:var(--line-2); }
  .btn.outline:hover { background:var(--hover); }

  /* ---------- Pastilles d'état ---------- */
  .badge {
    display:inline-flex; align-items:center; gap:5px; height:20px; padding:0 8px;
    border-radius:3px; font-size:10.5px; font-weight:600; letter-spacing:.01em;
    background:var(--hover); color:var(--tx-2);
  }
  .badge::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
  .badge.running { color:var(--warn-tx); background:rgba(255,205,41,.20); }
  .badge.running::before { animation:pulse 1.4s ease-in-out infinite; }
  .badge.done { color:var(--ok-tx); background:rgba(20,174,92,.12); }
  .badge.error { color:var(--bad-tx); background:rgba(242,72,34,.11); }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.25; } }

  /* ---------- Structure ---------- */
  .workbench {
    display:grid; grid-template-columns:216px minmax(0,1fr) 0;
    min-height:0; transition:grid-template-columns .18s ease;
  }
  body.editing-open .workbench { grid-template-columns:216px minmax(0,1fr) 248px; }
  .rail {
    background:var(--bg); border-right:1px solid var(--line);
    overflow-y:auto; padding:12px 0 20px; min-width:0;
  }
  .rail-title {
    display:flex; align-items:center; gap:6px; padding:0 12px; margin:0 0 8px;
    font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--tx-3);
  }
  .rail-title svg { opacity:.7; }
  .rail-group + .rail-group { margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }

  .runlist { list-style:none; margin:0; padding:0 6px; }
  .runlist a {
    display:block; padding:6px 8px; border-radius:var(--r); color:var(--tx-2);
    text-decoration:none; transition:background .14s ease;
  }
  .runlist a:hover { background:var(--hover); text-decoration:none; }
  .runlist a[aria-current] { background:var(--sel-soft); }
  .runlist .when { font-size:11.5px; font-weight:500; color:var(--tx); }
  .runlist .rid { display:block; font-family:var(--mono); font-size:10px; color:var(--tx-3); overflow-wrap:anywhere; margin-top:1px; }
  .runlist .tag { font-size:9.5px; font-weight:600; color:var(--ok-tx); letter-spacing:.04em; text-transform:uppercase; margin-left:6px; }

  .kv { padding:0 12px; margin:0; }
  .kv-row { display:flex; justify-content:space-between; gap:10px; font-size:11.5px; line-height:1.9; }
  .kv-row dt { color:var(--tx-3); }
  .kv-row dd { margin:0; color:var(--tx-2); font-family:var(--mono); font-size:10.5px; text-align:right; overflow-wrap:anywhere; }

  .passlist { list-style:none; margin:0; padding:0 6px; }
  .passlist a {
    display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:var(--r);
    color:var(--tx-2); font-size:11.5px; transition:background .14s ease;
  }
  .passlist a:hover { background:var(--hover); color:var(--tx); text-decoration:none; }
  .passlist .n { font-family:var(--mono); font-size:10px; color:var(--tx-3); flex:none; }
  .passlist li.cur > span {
    display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:var(--r);
    background:var(--sel-soft); color:var(--sel-tx); font-size:11.5px; font-weight:500;
  }
  .passlist li.cur .n { color:var(--sel-tx); }

  /* ---------- Plan de travail ---------- */
  .canvas {
    background:var(--canvas); overflow:auto; min-width:0; position:relative;
    background-image:radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size:16px 16px; background-position:-1px -1px;
  }
  .canvas-pad { padding:24px; min-height:100%; display:flex; flex-direction:column; }
  .canvas-center { align-items:center; justify-content:flex-start; }

  /* Feuille flottante : l'unité de contenu du plan de travail. */
  .sheet {
    background:#fff; border-radius:var(--r-lg); box-shadow:var(--shadow-sheet);
    width:100%; max-width:560px;
  }
  .sheet-head {
    display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
    padding:16px 20px; border-bottom:1px solid var(--line);
  }
  .sheet-head h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:-0.012em; }
  .sheet-head p { margin:3px 0 0; font-size:11.5px; color:var(--tx-3); }
  .sheet-head svg { width:18px; height:18px; }
  .sheet-body { padding:18px 20px; }
  .sheet-foot { padding:14px 20px; border-top:1px solid var(--line); }
  .step-n {
    display:inline-flex; align-items:center; justify-content:center; width:17px; height:17px;
    border-radius:3px; background:var(--hover); color:var(--tx-2);
    font-family:var(--mono); font-size:10px; font-weight:600; margin-right:8px; flex:none;
  }
  .sec { display:flex; align-items:center; margin:0 0 10px; font-size:12px; font-weight:600; color:var(--tx); }
  .sec .opt { font-weight:400; color:var(--tx-3); margin-left:5px; }

  /* ---------- Dépôt de fichier ---------- */
  #dropzone {
    border:1.5px dashed var(--line-2); border-radius:var(--r-lg); padding:34px 20px; text-align:center;
    cursor:pointer; background:var(--bg-2); transition:border-color .14s ease, background .14s ease;
  }
  #dropzone:hover { border-color:#b4b4b4; }
  #dropzone.drag { border-color:var(--sel); background:var(--sel-soft); }
  #dropzone.has-file { border-style:solid; border-color:var(--sel); background:var(--sel-soft); text-align:left; }
  #dropzone .dz-icon { color:#8f8f8f; display:flex; }
  #dropzone .dz-icon svg { width:22px; height:22px; }
  #dropzone.has-file .dz-icon { color:var(--sel); }
  #dropzone .dz-inner { display:flex; align-items:center; gap:12px; justify-content:center; }
  #dropzone.has-file .dz-inner { justify-content:flex-start; }
  #dropzone .big { font-size:12.5px; font-weight:600; color:var(--tx); margin:0; overflow-wrap:anywhere; }
  #dropzone p.sub { color:var(--tx-3); margin:2px 0 0; font-size:11.5px; }
  #dropzone.has-file p.sub { color:var(--sel-tx); }

  .field-row {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    margin-top:14px; padding-top:14px; border-top:1px solid var(--line);
    font-size:11.5px; color:var(--tx-2);
  }
  .field-row label { font-weight:500; color:var(--tx); }
  .field-row .hint { display:block; font-weight:400; color:var(--tx-3); margin-top:1px; }
  input[type=number].num {
    width:60px; height:28px; padding:0 8px; border:1px solid var(--line-2); border-radius:var(--r);
    background:#fff; color:var(--tx); font-family:var(--mono); font-size:11.5px;
    text-align:right; font-variant-numeric:tabular-nums;
  }
  input[type=number].num:focus { outline:none; border-color:var(--sel); box-shadow:0 0 0 2px var(--sel-soft); }

  /* ---------- Onglets ---------- */
  .tabs { display:inline-flex; background:var(--hover); border-radius:5px; padding:2px; gap:2px; }
  .tab-btn {
    border:none; background:transparent; padding:4px 10px; font-size:11px; font-weight:500;
    color:var(--tx-2); border-radius:3px; cursor:pointer; transition:background .14s ease, color .14s ease;
  }
  .tab-btn:hover { color:var(--tx); }
  .tab-btn.active { background:#fff; color:var(--tx); box-shadow:0 1px 2px rgba(0,0,0,.10); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }

  #extraConfigDrop {
    border:1.5px dashed var(--line-2); border-radius:var(--r); padding:18px 14px; text-align:center;
    cursor:pointer; font-size:11.5px; color:var(--tx-3); background:var(--bg-2);
    transition:border-color .14s ease, background .14s ease;
  }
  #extraConfigDrop:hover { border-color:#b4b4b4; }
  #extraConfigDrop.drag { border-color:var(--sel); background:var(--sel-soft); }
  #extraConfigDrop.has-file { border-style:solid; border-color:var(--sel); background:var(--sel-soft); color:var(--sel-tx); font-weight:600; }
  #extraConfigText {
    width:100%; min-height:132px; font-family:var(--mono); font-size:11px; line-height:1.65;
    padding:10px 12px; border:1px solid var(--line-2); border-radius:var(--r); resize:vertical;
    color:var(--tx); background:var(--bg-2);
  }
  #extraConfigText:focus { outline:none; background:#fff; border-color:var(--sel); box-shadow:0 0 0 2px var(--sel-soft); }
  /* Hauteur réservée : le message de validation ne doit pas décaler le bouton. */
  #extraConfigStatus { font-size:11px; margin-top:6px; min-height:16px; color:var(--tx-3); }
  #extraConfigStatus.ok { color:var(--ok-tx); }
  #extraConfigStatus.err { color:var(--bad-tx); }
  #submitBtn { width:100%; height:34px; font-size:12.5px; }

  /* ---------- Rail d'étapes (élément signature) ---------- */
  .stages { list-style:none; margin:0; padding:0; }
  .stage { display:grid; grid-template-columns:24px minmax(0,1fr); gap:12px; }
  .stage-mark { position:relative; display:flex; justify-content:center; }
  /* Le trait relie les noeuds ; il s'arrête au dernier. */
  .stage:not(:last-child) .stage-mark::after {
    content:""; position:absolute; top:20px; bottom:-4px; left:50%; width:1.5px;
    transform:translateX(-50%); background:var(--line);
  }
  .stage.past:not(:last-child) .stage-mark::after { background:var(--ok); }
  .stage-dot {
    width:18px; height:18px; border-radius:50%; border:1.5px solid var(--line-2);
    background:#fff; display:flex; align-items:center; justify-content:center;
    font-family:var(--mono); font-size:9px; font-weight:600; color:var(--tx-3);
    flex:none; position:relative; z-index:1;
  }
  .stage-body { padding-bottom:16px; min-width:0; }
  .stage:last-child .stage-body { padding-bottom:0; }
  .stage-name { font-size:12px; font-weight:500; color:var(--tx-3); }
  .stage-note { font-size:11.5px; color:var(--tx-3); margin-top:1px; overflow-wrap:anywhere; }
  .stage.past .stage-dot { background:var(--ok); border-color:var(--ok); color:#fff; }
  .stage.past .stage-name { color:var(--tx-2); }
  .stage.now .stage-dot { border-color:var(--sel); color:var(--sel); box-shadow:0 0 0 4px var(--sel-soft); }
  .stage.now .stage-name { color:var(--tx); font-weight:600; }
  .stage.now .stage-note { color:var(--tx-2); }
  .stage.now .stage-dot::before {
    content:""; position:absolute; inset:-1.5px; border-radius:50%;
    border:1.5px solid var(--sel); animation:ring 1.8s ease-out infinite;
  }
  @keyframes ring { 0% { transform:scale(1); opacity:.9; } 70%,100% { transform:scale(1.9); opacity:0; } }

  /* ---------- Consoles ---------- */
  .console-head {
    display:flex; align-items:center; gap:7px; padding:0 0 7px; flex:none;
    font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--tx-2);
  }
  .console-head svg { width:13px; height:13px; }
  .console {
    background:#fff; border:1px solid var(--line); border-radius:var(--r-lg); color:#3c3c3c;
    font-family:var(--mono); font-size:11px; line-height:1.7; padding:12px 14px;
    overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:0;
    box-shadow:0 1px 2px rgba(0,0,0,.05);
  }
  .console:empty::after { content:"En attente de la première étape..."; color:var(--tx-3); }
  .stream-live { color:var(--sel-tx); text-transform:none; letter-spacing:0; font-weight:500; font-size:11.5px; }

  /* Écran de suivi : tout tient dans la hauteur, chaque panneau défile chez lui. */
  .run-grid {
    display:grid; grid-template-columns:minmax(300px,400px) minmax(0,1fr);
    gap:20px; flex:1; min-height:0;
  }
  .run-col { display:flex; flex-direction:column; gap:16px; min-height:0; }
  .run-col .sheet { max-width:none; overflow-y:auto; }
  .console-block { display:flex; flex-direction:column; min-height:0; flex:1; }
  .console-block .console { flex:1; min-height:0; }
  @media (max-width:1000px) { .run-grid { grid-template-columns:minmax(0,1fr); } }

  /* ---------- Viewport pan/zoom ---------- */
  .viewport {
    position:relative; overflow:hidden; background:var(--canvas); min-width:0;
    background-image:radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size:16px 16px; touch-action:none; cursor:grab;
    overscroll-behavior:contain;
  }
  .viewport.panning { cursor:grabbing; }
  body.space .viewport { cursor:grab; }
  body.space .viewport.panning { cursor:grabbing; }
  .world { position:absolute; top:0; left:0; transform-origin:0 0; will-change:transform; }
  .board {
    position:absolute; top:0; background:#fff; box-shadow:var(--shadow-sheet);
  }
  .board > iframe, .board > img, .board > embed { display:block; border:none; width:100%; height:100%; }
  /* Le nom de frame garde une taille d'écran constante quel que soit le zoom. */
  .frame-name {
    position:absolute; left:0; bottom:100%; margin-bottom:7px; white-space:nowrap;
    display:flex; align-items:center; gap:8px; transform-origin:0 100%;
    font-size:11px; font-weight:500; color:var(--tx-2); letter-spacing:-0.004em; pointer-events:none;
  }
  .frame-name .fn-sub { color:var(--tx-3); font-weight:400; }
  /* Capte le survol et le glisser au-dessus des cadres, pour que la molette et
     le déplacement marchent partout -- sauf en mode édition, où la souris doit
     atteindre les éléments de la preview. */
  .board-shield { position:absolute; inset:0; z-index:2; }
  body.editing-open .board-shield { pointer-events:none; }
  body.editing-open.space .board-shield { pointer-events:auto; }
  #previewPane.editing { box-shadow:var(--shadow-sheet), 0 0 0 1.5px var(--sel); }
  #previewPane.editing .frame-name { color:var(--sel); font-weight:600; }
  body.editing-open #targetPane { opacity:.45; }

  /* Pastille de zoom : flotte au-dessus du plan de travail, comme les contrôles
     de vue d'un éditeur. */
  .zoombar {
    position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
    display:flex; align-items:center; gap:2px; padding:3px;
    background:#fff; border:1px solid var(--line); border-radius:8px;
    box-shadow:var(--shadow-pop); z-index:10; user-select:none;
  }
  .zoombar button {
    height:26px; min-width:26px; padding:0 8px; border:none; background:transparent;
    color:var(--tx-2); border-radius:5px; cursor:pointer; font-size:11px; font-weight:500;
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    transition:background .14s ease, color .14s ease;
  }
  .zoombar button:hover { background:var(--hover); color:var(--tx); }
  .zoombar .zval {
    min-width:52px; font-family:var(--mono); font-size:11px; color:var(--tx);
    font-variant-numeric:tabular-nums;
  }
  .zoombar .zsep { width:1px; height:16px; background:var(--line); margin:0 3px; }
  .zoomhint {
    position:absolute; bottom:20px; right:16px; z-index:10; pointer-events:none;
    font-size:10.5px; color:var(--tx-3); text-align:right; line-height:1.7;
  }
  .zoomhint kbd {
    background:#fff; border:1px solid var(--line-2); border-bottom-width:2px; border-radius:3px;
    padding:1px 4px; font-size:9.5px; font-family:var(--mono); color:var(--tx-2);
  }

  .empty { padding:16px; font-size:11.5px; color:var(--tx-3); }
  .error-sheet { border-left:3px solid var(--bad); }
  .error-msg {
    font-family:var(--mono); font-size:11.5px; line-height:1.7; color:#8a2415;
    background:#fdf2f0; border-radius:var(--r); padding:12px 14px; margin:0;
    white-space:pre-wrap; overflow-wrap:anywhere;
  }

  /* ---------- Panneau d'inspection ---------- */
  #editSidebar {
    background:var(--bg); border-left:1px solid var(--line); overflow-y:auto;
    padding:14px 12px 16px; display:none; flex-direction:column; gap:14px; min-width:0;
  }
  #editSidebar.open { display:flex; }
  #editSidebar h3 { margin:0; font-size:12px; font-weight:600; }
  #editSidebar .sb-label {
    font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.07em;
    color:var(--tx-3); margin:0 0 6px;
  }
  #editSidebar .sb-box { background:var(--bg-2); border:1px solid var(--line); border-radius:var(--r); padding:8px 10px; }
  #editSidebar .sb-row {
    display:flex; justify-content:space-between; align-items:center; gap:8px;
    font-size:11px; color:var(--tx); line-height:2; font-variant-numeric:tabular-nums;
  }
  #editSidebar .sb-row span:first-child { color:var(--tx-3); }
  #editSidebar kbd, .sb-keys kbd {
    background:var(--hover); border:1px solid var(--line-2); border-bottom-width:2px;
    border-radius:3px; padding:1px 5px; font-size:10px; font-family:var(--mono); color:var(--tx-2);
  }
  #editSidebar .sb-keys { font-size:11px; color:var(--tx-3); line-height:2.1; }
  #editSidebar .sb-actions { margin-top:auto; display:flex; flex-direction:column; gap:7px; }
  #editSidebar .sb-btn {
    width:100%; height:28px; border-radius:var(--r); font-size:11.5px; font-weight:500;
    cursor:pointer; border:1px solid var(--line-2); background:#fff; color:var(--tx);
    transition:background .14s ease, color .14s ease;
  }
  #editSidebar .sb-btn:hover { background:var(--hover); }
  #editSidebar .sb-btn.primary { background:var(--sel); color:#fff; border-color:var(--sel); }
  #editSidebar .sb-btn.primary:hover { background:#0b86e0; }
  #editSidebar .sb-btn.primary:disabled { background:#e9e9e9; color:#a3a3a3; border-color:#e9e9e9; cursor:not-allowed; }
  #editSidebar .sb-status { font-size:10.5px; color:var(--tx-3); text-align:center; min-height:15px; }
  #editSidebar .mode-btn { flex:1; height:24px; font-size:10.5px; }
  #editSidebar .mode-btn.active { background:var(--sel-soft); color:var(--sel-tx); border-color:var(--sel); }
  #editSidebar .pad-in {
    width:66px; height:22px; padding:0 6px; border:1px solid var(--line-2); border-radius:3px;
    background:#fff; color:var(--tx); font-family:var(--mono); font-size:10.5px;
    text-align:right; font-variant-numeric:tabular-nums;
  }
  #editSidebar .pad-in:focus { outline:none; border-color:var(--sel); }
  #editSidebar input[type=range] { width:100%; accent-color:var(--sel); margin:6px 0 0; }
  #editSidebar input[type=checkbox] { accent-color:var(--sel); width:13px; height:13px; cursor:pointer; }

  @media (max-width:900px) {
    .workbench, body.editing-open .workbench { grid-template-columns:minmax(0,1fr); }
    .rail { display:none; }
  }
  @media (prefers-reduced-motion:reduce) {
    *, *::before, *::after { animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important; }
  }
</style></head>
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

/** Les étapes réelles émises par runPipeline, dans l'ordre. Elles servent de
 * fil conducteur à l'écran de suivi : "extract" puis 3 tentatives Claude puis
 * 2 correctifs de taille. `render` est un sous-message d'une passe et `done`
 * la fin -- ni l'un ni l'autre n'est une étape à part entière. */
const STAGES = [
  { id: "extract", name: "Extraction", note: "Capture de la page cible et dictionnaire HTML" },
  { id: "pass1", name: "Passe 1", note: "Premier jet du composant" },
  { id: "pass2", name: "Passe 2", note: "Correction guidée par le diff visuel" },
  { id: "pass3", name: "Passe 3", note: "Audit du rendu" },
  { id: "scale-fix", name: "Passe 4", note: "Recalage de l'échelle globale" },
  { id: "size-fix", name: "Passe 5", note: "Ajustement taille par élément" },
];

/** Rail d'étapes : les passes franchies, celle en cours, celles à venir.
 * Un simple libellé "Étape : pass2" ne dit pas où on en est dans la
 * séquence -- ici la position dans la liste porte l'information. */
function renderStages(currentStep, message) {
  const known = STAGES.findIndex((s) => s.id === currentStep);
  // "render" et les avertissements arrivent pendant une passe : on reste sur
  // la dernière étape connue plutôt que de retomber à zéro.
  const idx = currentStep === "done" ? STAGES.length : (known === -1 ? 0 : known);
  return `<ol class="stages">
    ${STAGES.map((s, i) => {
      const state = i < idx ? "past" : i === idx ? "now" : "";
      const note = state === "now" && message ? message : s.note;
      return `<li class="stage ${state}">
        <div class="stage-mark"><span class="stage-dot">${i < idx ? "✓" : i + 1}</span></div>
        <div class="stage-body">
          <div class="stage-name">${s.name}</div>
          <div class="stage-note">${note}</div>
        </div>
      </li>`;
    }).join("")}
  </ol>`;
}

/** Liste des runs terminés relisibles depuis le disque : permet de rouvrir un
 * résultat et d'y retoucher les images sans relancer de génération payante.
 * Les identifiants commencent par un horodatage, donc l'ordre inverse met
 * bien le plus récent en premier. */
function runTime(dirName) {
  // Deux conventions cohabitent dans out/ : un horodatage en millisecondes
  // (runs récents) et un ISO avec tirets (anciens). La date du dossier
  // couvre les deux sans avoir à deviner le format du nom.
  const ms = /^\d{13}-/.test(dirName) ? parseInt(dirName.slice(0, 13), 10) : NaN;
  if (Number.isFinite(ms)) return ms;
  try { return fs.statSync(path.join(OUT_ROOT, dirName)).mtimeMs; } catch { return 0; }
}

function pastRuns(limit = 14) {
  if (!fs.existsSync(OUT_ROOT)) return [];
  return fs.readdirSync(OUT_ROOT)
    .filter((d) => fs.existsSync(path.join(OUT_ROOT, d, "attempt1.jsx")))
    .map((d) => ({ d, t: runTime(d) }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.d);
}

function runWhen(dirName) {
  const t = runTime(dirName);
  if (!t) return dirName;
  return new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function runsRail(currentId = null) {
  const past = pastRuns(currentId ? 6 : 14);
  return `<div class="rail-group">
    <p class="rail-title">${ICON.layers} Runs</p>
    ${past.length
      ? `<ul class="runlist">${past.map((d, i) => `<li>
          <a href="/runs/${d}"${d === currentId ? ' aria-current="page"' : ""}>
            <span class="when">${runWhen(d)}</span>${i === 0 ? `<span class="tag">dernier</span>` : ""}
            <span class="rid">${d}</span>
          </a>
        </li>`).join("")}</ul>`
      : `<p style="padding:0 12px;font-size:11.5px;color:var(--tx-3);margin:0">Aucun run pour l'instant. Le premier apparaîtra ici.</p>`}
  </div>`;
}

app.get("/", (_req, res) => {
  res.send(layout("Pipeline Design-to-Code", {
    crumb: `<span class="cur">Nouveau run</span>`,
    rail: runsRail(),
    main: `<main class="canvas"><div class="canvas-pad canvas-center">
      <form id="uploadForm" class="sheet" action="/run" method="post" enctype="multipart/form-data">
        <div class="sheet-head">
          <div>
            <h2>Nouveau run</h2>
            <p>Une page de PDF entre, un composant React en sort. 5 passes : extraction, 3 tentatives, correctifs de taille.</p>
          </div>
        </div>

        <div class="sheet-body">
          <p class="sec"><span class="step-n">1</span>PDF source</p>
          <div id="dropzone">
            <div class="dz-inner">
              <span class="dz-icon">${ICON.file}</span>
              <div>
                <p class="big">Glisse un PDF ici</p>
                <p class="sub">ou clique pour en choisir un</p>
              </div>
            </div>
            <input type="file" name="pdf" accept="application/pdf" id="fileInput" hidden>
          </div>

          <div class="field-row">
            <label for="pageInput">Page à traiter<span class="hint">Une seule page par run.</span></label>
            <input type="number" class="num" name="page" id="pageInput" value="1" min="1">
          </div>
        </div>

        <div class="sheet-head" style="border-top:1px solid var(--sheet-rule);border-bottom:none;align-items:center">
          <div>
            <h2><span class="step-n">2</span>extra_config<span style="font-weight:400;color:var(--sheet-tx-3)"> — optionnel</span></h2>
            <p>Schéma réel du template (CvParserConfig). Sans lui, un schéma générique est utilisé.</p>
          </div>
          <div class="tabs">
            <button type="button" class="tab-btn active" data-tab="file">Fichier</button>
            <button type="button" class="tab-btn" data-tab="paste">Coller</button>
          </div>
        </div>
        <div class="sheet-body" style="padding-top:0">
          <div class="tab-panel active" data-panel="file">
            <div id="extraConfigDrop">
              <span id="extraConfigDropLabel">Glisse un fichier .json ici ou clique pour en choisir un</span>
              <input type="file" name="extraConfig" accept="application/json,.json" id="extraConfigInput" hidden>
            </div>
          </div>
          <div class="tab-panel" data-panel="paste">
            <textarea id="extraConfigText" spellcheck="false" placeholder='{ "frontend_cvparser_config": [ ... ] }'></textarea>
            <div id="extraConfigStatus" role="status"></div>
          </div>
        </div>

        <div class="sheet-foot">
          <button type="submit" id="submitBtn" class="btn primary" disabled>${ICON.play}<span class="btn-label">Choisis d'abord un PDF</span></button>
        </div>
        <input type="hidden" name="extraConfigText" id="extraConfigTextHidden">
      </form>
    </div></main>`,
    script: `<script>
      const dz = document.getElementById('dropzone');
      const input = document.getElementById('fileInput');
      const form = document.getElementById('uploadForm');
      const submitBtn = document.getElementById('submitBtn');
      const submitLabel = submitBtn.querySelector('.btn-label');

      function setPdf(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        dz.classList.add('has-file');
        dz.querySelector('.big').textContent = file.name;
        dz.querySelector('.sub').textContent = (file.size / 1024 / 1024).toFixed(2) + ' Mo — prêt';
        submitBtn.disabled = false;
        submitLabel.textContent = 'Lancer la génération';
      }
      dz.addEventListener('click', () => input.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        if (e.dataTransfer.files.length) setPdf(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files.length) setPdf(input.files[0]); });

      // Onglets fichier / coller pour l'extra_config
      const tabBtns = document.querySelectorAll('.tab-btn');
      const panels = document.querySelectorAll('.tab-panel');
      tabBtns.forEach((btn) => btn.addEventListener('click', () => {
        tabBtns.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.querySelector('.tab-panel[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
      }));

      // extra_config par fichier
      const ecDrop = document.getElementById('extraConfigDrop');
      const ecInput = document.getElementById('extraConfigInput');
      const ecLabel = document.getElementById('extraConfigDropLabel');
      function setExtraConfigFile(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        ecInput.files = dt.files;
        ecDrop.classList.add('has-file');
        ecLabel.textContent = file.name;
      }
      ecDrop.addEventListener('click', () => ecInput.click());
      ecDrop.addEventListener('dragover', (e) => { e.preventDefault(); ecDrop.classList.add('drag'); });
      ecDrop.addEventListener('dragleave', () => ecDrop.classList.remove('drag'));
      ecDrop.addEventListener('drop', (e) => {
        e.preventDefault(); ecDrop.classList.remove('drag');
        if (e.dataTransfer.files.length) setExtraConfigFile(e.dataTransfer.files[0]);
      });
      ecInput.addEventListener('change', () => { if (ecInput.files.length) setExtraConfigFile(ecInput.files[0]); });

      // extra_config collé en texte -- validation JSON en direct + recopie dans le champ caché envoyé au serveur
      const ecText = document.getElementById('extraConfigText');
      const ecTextHidden = document.getElementById('extraConfigTextHidden');
      const ecStatus = document.getElementById('extraConfigStatus');
      ecText.addEventListener('input', () => {
        const val = ecText.value.trim();
        ecTextHidden.value = val;
        if (!val) { ecStatus.textContent = ''; ecStatus.className = ''; return; }
        try {
          JSON.parse(val);
          ecStatus.textContent = 'JSON valide';
          ecStatus.className = 'ok';
        } catch (e) {
          ecStatus.textContent = 'JSON invalide : ' + e.message;
          ecStatus.className = 'err';
        }
      });

      form.addEventListener('submit', (e) => {
        if (ecText.value.trim()) {
          try { JSON.parse(ecText.value.trim()); }
          catch {
            e.preventDefault();
            ecStatus.textContent = 'Corrige le JSON avant de lancer.';
            ecStatus.className = 'err';
            document.querySelector('.tab-btn[data-tab="paste"]').click();
            ecText.focus();
            return;
          }
        }
        submitBtn.disabled = true;
        submitLabel.textContent = 'Démarrage...';
      });
    </script>`,
  }));
});

app.post("/run", upload.fields([{ name: "pdf", maxCount: 1 }, { name: "extraConfig", maxCount: 1 }]), (req, res) => {
  const pdfFile = req.files?.pdf?.[0];
  if (!pdfFile) return res.status(400).send("PDF manquant.");
  const extraConfigFile = req.files?.extraConfig?.[0];
  const pageNumber = parseInt(req.body.page || "1", 10);

  // extra_config peut venir soit d'un fichier uploadé, soit de JSON collé
  // dans le textarea (envoyé dans le champ caché extraConfigText) -- dans
  // ce 2e cas on l'écrit dans un fichier temporaire pour réutiliser
  // exactement le même chemin (extraConfigPath) côté runPipeline.
  let extraConfigPath = extraConfigFile?.path;
  const extraConfigText = (req.body.extraConfigText || "").trim();
  if (!extraConfigPath && extraConfigText) {
    try {
      JSON.parse(extraConfigText);
    } catch (err) {
      return res.status(400).send(`extra_config collé n'est pas un JSON valide : ${err.message}`);
    }
    extraConfigPath = path.join(UPLOADS_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(extraConfigPath, extraConfigText);
  }

  const runId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const outDir = path.join(OUT_ROOT, runId);
  const state = {
    status: "running", step: "extract", message: "Démarrage...", log: [],
    stream: { step: null, kind: null, text: "" },
    result: null, error: null, pdfUrl: "/uploads/" + path.basename(pdfFile.path), page: pageNumber,
  };
  runs.set(runId, state);

  runPipeline({
    pdfPath: pdfFile.path,
    pageNumber,
    extraConfigPath,
    outDir,
    onProgress: (step, message) => {
      state.step = step;
      state.message = message;
      state.log.push({ step, message });
    },
    onStream: (step, kind, text) => {
      state.stream = { step, kind, text };
    },
  })
    .then((result) => {
      state.status = "done";
      state.result = result;
      // Trace sur disque : permet de rouvrir ce run après un redémarrage du
      // serveur (les runs ne vivent qu'en mémoire autrement).
      try {
        fs.writeFileSync(
          path.join(outDir, "run-meta.json"),
          JSON.stringify({
            pdfUrl: state.pdfUrl,
            page: state.page,
            width: result.width,
            height: result.height,
            finishedAt: new Date().toISOString(),
            tokens: {
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              totalCacheReadTokens: result.totalCacheReadTokens,
              totalCacheWriteTokens: result.totalCacheWriteTokens,
            },
          }, null, 2)
        );
      } catch { /* la trace est un confort, pas un prérequis */ }
    })
    .catch((err) => { state.status = "error"; state.error = err.message; });

  res.redirect(303, `/runs/${runId}`);
});

/** Re-rend la dernière passe telle quelle (aucun appel Claude). Sert aux
 * runs générés avant l'ajout des repères `data-cvimg` : sans eux, l'éditeur
 * ne peut relier une image du rendu à sa balise dans le JSX. */
app.post("/runs/:id/rerender", (req, res) => {
  const state = getRun(req.params.id);
  if (!state || state.status !== "done") return res.status(404).send("Run introuvable ou pas terminé.");
  const finalPass = state.result.passes.at(-1);
  const runCvData = path.join(state.result.outDir, "generated_cvdata.json");
  const cvDataPath = fs.existsSync(runCvData) ? runCvData : path.join(__dirname, "sample_cvdata.json");
  const r = spawnSync(
    "node",
    [path.join(__dirname, "render.mjs"), finalPass.jsxPath, cvDataPath,
      finalPass.pngPath, String(state.result.width), String(state.result.height)],
    { encoding: "utf-8", cwd: __dirname }
  );
  if (r.status !== 0) return res.status(500).send(`Rendu échoué: ${r.stderr || r.stdout}`);
  res.json({ ok: true });
});

app.get("/editor-overlay.js", (_req, res) => {
  // Jamais de cache : ce script évolue souvent, et une version périmée
  // servie depuis le cache du navigateur donne un éditeur qui "ne marche
  // pas" alors que le correctif est bien sur le disque.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.type("application/javascript").sendFile(path.join(__dirname, "editor_overlay.js"));
});

/** Applique dans le JSX les ajustements d'images faits à la souris, puis
 * re-rend. Le résultat écrase le .jsx de la dernière passe pour que le
 * téléchargement et la preview repartent du code corrigé. */
app.post("/runs/:id/image-edits", express.json({ limit: "1mb" }), (req, res) => {
  const state = getRun(req.params.id);
  if (!state || state.status !== "done") return res.status(404).send("Run introuvable ou pas terminé.");
  const edits = req.body?.edits || {};
  const textEdits = req.body?.textEdits || {};
  const classEdits = req.body?.classEdits || {};
  if (!Object.keys(edits).length && !Object.keys(textEdits).length && !Object.keys(classEdits).length)
    return res.status(400).send("Aucun ajustement reçu.");

  const finalPass = state.result.passes.at(-1);
  try {
    const imgPass = applyImageEdits(fs.readFileSync(finalPass.jsxPath, "utf-8"), edits);
    const textPass = applyTextEdits(imgPass.source, textEdits);
    const classPass = applyClassEdits(textPass.source, classEdits);
    const applied = [...imgPass.applied, ...textPass.applied, ...classPass.applied];
    if (!applied.length) return res.status(400).send("Aucune balise correspondante trouvée dans le JSX.");
    fs.writeFileSync(finalPass.jsxPath, classPass.source);

    // Mêmes données que le run d'origine : si un extra_config a été fourni,
    // le JSON dérivé de ce schéma est dans le dossier du run -- rendre avec
    // le schéma générique afficherait d'autres champs que ceux que
    // l'utilisateur vient d'ajuster à l'écran.
    const runCvData = path.join(state.result.outDir, "generated_cvdata.json");
    const cvDataPath = fs.existsSync(runCvData) ? runCvData : path.join(__dirname, "sample_cvdata.json");
    const r = spawnSync(
      "node",
      [path.join(__dirname, "render.mjs"), finalPass.jsxPath, cvDataPath,
        finalPass.pngPath, String(state.result.width), String(state.result.height)],
      { encoding: "utf-8", cwd: __dirname }
    );
    if (r.status !== 0) return res.status(500).send(`Rendu échoué: ${r.stderr || r.stdout}`);
    res.json({ ok: true, applied });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/runs/:id/status.json", (req, res) => {
  const state = getRun(req.params.id);
  if (!state) return res.status(404).json({ error: "run introuvable" });
  res.json({ status: state.status, step: state.step, message: state.message, log: state.log, stream: state.stream, error: state.error });
});

app.get("/runs/:id/download", (req, res) => {
  const state = getRun(req.params.id);
  if (!state || state.status !== "done") return res.status(404).send("Run introuvable ou pas terminé.");

  const finalPass = state.result.passes.at(-1);
  const { jsxCode, componentName, images } = collectDownloadAssets(finalPass.jsxPath);

  const readme = `Composant généré par la pipeline Design-to-Code -- run ${req.params.id}, page ${state.page}.

Contenu :
- ${componentName}.jsx -- le composant React
- images/cv-templates/.../*.png -- les vraies images extraites du PDF source, référencées par le composant

Ce qui n'est PAS inclus / à vérifier avant intégration :
- Le fichier CSS que le composant importe (ex: xxxSmartCv.css) n'existe pas ici -- il n'a jamais été généré, son import est vide dans ce test. Vérifie s'il faut en écrire un (l'exemple Visian en a un, avec quelques classes custom hors Tailwind).
- Les imports du moteur (@/components/CvSmart/templates/engine/...) et du schéma cvData supposent que ce composant vit dans le même projet que templates copy/ -- adapte les chemins si tu le déplaces ailleurs.
- Ce composant n'a été testé que dans le harness de test de la pipeline (React seul + données factices), pas dans l'app CV Smart réelle.
`;

  res.attachment(`${componentName}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);
  archive.append(jsxCode, { name: `${componentName}.jsx` });
  archive.append(readme, { name: "README.txt" });
  for (const img of images) archive.file(img.abs, { name: img.zipPath });
  archive.finalize();
});

/** Les messages de la pipeline peuvent contenir des extraits de code ou de
 * stack trace : sans échappement, un `<` suffit à casser la page. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Écart entre les deux cadres dans le plan de travail, en pixels du document. */
const BOARD_GAP = 80;

app.get("/runs/:id", (req, res) => {
  const state = getRun(req.params.id);
  if (!state) return res.status(404).send("Run introuvable.");

  const runId = req.params.id;
  const crumb = `<a href="/">Runs</a><span>/</span><span class="idchip">${esc(runId)}</span>`;
  const backBtn = `<a class="btn ghost" href="/">${ICON.back}<span>Nouveau run</span></a>`;
  const backIcon = `<a class="btn ghost icon" href="/" title="Nouveau run" aria-label="Nouveau run">${ICON.back}</a>`;

  // ---------------------------------------------------------------- en cours
  if (state.status !== "done" && state.status !== "error") {
    return res.send(layout("Run en cours", {
      crumb,
      status: `<span class="badge running">En cours</span>`,
      actions: backBtn,
      rail: `<div class="rail-group">
          <p class="rail-title">Ce run</p>
          <dl class="kv">
            <div class="kv-row"><dt>Page</dt><dd>${state.page}</dd></div>
            <div class="kv-row"><dt>Démarré</dt><dd>${runWhen(runId)}</dd></div>
            <div class="kv-row"><dt>Écoulé</dt><dd id="elapsed">—</dd></div>
          </dl>
        </div>
        ${runsRail(runId)}`,
      // Deux colonnes : les étapes à gauche, ce que la machine dit à droite.
      // Tout tient dans la hauteur de la fenêtre, chaque panneau défile chez lui.
      main: `<main class="canvas"><div class="canvas-pad">
        <div class="run-grid">
          <div class="run-col">
            <div class="sheet">
              <div class="sheet-head">
                <div>
                  <h2>Génération en cours</h2>
                  <p>5 passes, dont 3 appels à Claude. Tu peux laisser cet onglet ouvert.</p>
                </div>
              </div>
              <div class="sheet-body" id="live">${renderStages(state.step, state.message)}</div>
            </div>
          </div>
          <div class="run-col">
            <div class="console-block" id="streambox-wrap" hidden>
              <p class="console-head"><span id="streambox-icon">${ICON.think}</span><span class="stream-live" id="streambox-label"></span></p>
              <pre class="console" id="streambox"></pre>
            </div>
            <div class="console-block">
              <p class="console-head">Journal</p>
              <pre class="console" id="logbox"></pre>
            </div>
          </div>
        </div>
      </div></main>`,
      script: `<script>
        const STAGE_IDS = ${JSON.stringify(STAGES.map((s) => s.id))};
        const STAGE_NAMES = ${JSON.stringify(Object.fromEntries(STAGES.map((s) => [s.id, s.name])))};
        const startedAt = ${parseInt(runId.split("-")[0], 10) || Date.now()};

        function tickElapsed() {
          const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
          const el = document.getElementById('elapsed');
          if (el) el.textContent = Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
        }
        setInterval(tickElapsed, 1000); tickElapsed();

        // Le rail d'étapes est rendu par le serveur au premier chargement ;
        // ensuite on ne repositionne que le curseur, sans reconstruire le DOM
        // (sinon l'anneau de l'étape active repart de zéro à chaque sondage).
        function paintStages(step, message) {
          const known = STAGE_IDS.indexOf(step);
          const idx = step === 'done' ? STAGE_IDS.length : (known === -1 ? 0 : known);
          document.querySelectorAll('.stage').forEach((li, i) => {
            li.classList.toggle('past', i < idx);
            li.classList.toggle('now', i === idx);
            const dot = li.querySelector('.stage-dot');
            if (dot) dot.textContent = i < idx ? '\\u2713' : String(i + 1);
            if (i === idx && message) li.querySelector('.stage-note').textContent = message;
          });
        }

        async function poll() {
          let s;
          try {
            const r = await fetch('/runs/${runId}/status.json');
            s = await r.json();
          } catch { setTimeout(poll, 2000); return; }

          paintStages(s.step, s.message);
          const log = document.getElementById('logbox');
          const logAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
          log.textContent = s.log.map(l => '[' + l.step + '] ' + l.message).join('\\n');
          if (logAtBottom) log.scrollTop = log.scrollHeight;

          if (s.stream && s.stream.text) {
            const wrap = document.getElementById('streambox-wrap');
            const box = document.getElementById('streambox');
            const label = document.getElementById('streambox-label');
            const icon = document.getElementById('streambox-icon');
            wrap.hidden = false;
            const thinking = s.stream.kind === 'thinking';
            icon.innerHTML = thinking ? ${JSON.stringify(ICON.think)} : ${JSON.stringify(ICON.write)};
            label.textContent = (thinking ? 'Réflexion' : 'Écriture') + ' — ' + (STAGE_NAMES[s.stream.step] || s.stream.step);
            // On ne recolle en bas que si l'utilisateur y était déjà : sinon
            // relire un passage plus haut devient impossible.
            const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
            box.textContent = s.stream.text;
            if (wasAtBottom) box.scrollTop = box.scrollHeight;
          }
          if (s.status === 'done' || s.status === 'error') { location.reload(); return; }
          setTimeout(poll, 1000);
        }
        poll();
      </script>`,
    }));
  }

  // ------------------------------------------------------------------ erreur
  if (state.status === "error") {
    return res.send(layout("Erreur", {
      crumb,
      status: `<span class="badge error">Échec</span>`,
      actions: backBtn,
      rail: runsRail(runId),
      main: `<main class="canvas"><div class="canvas-pad canvas-center">
        <div class="sheet error-sheet">
          <div class="sheet-head">
            <div>
              <h2>Le run s'est arrêté</h2>
              <p>Rien n'a été écrasé. Relance depuis le même PDF, ou corrige l'extra_config d'abord.</p>
            </div>
            <span style="color:var(--bad);flex:none">${ICON.warn}</span>
          </div>
          <div class="sheet-body"><pre class="error-msg">${esc(state.error)}</pre></div>
          <div class="sheet-foot"><a class="btn primary" href="/" style="width:100%;height:32px">${ICON.play}<span>Nouveau run</span></a></div>
        </div>
      </div></main>`,
    }));
  }

  // --------------------------------------------------------------- résultat
  const { result } = state;
  // La capture cible sert à la fois de cadre de gauche et de calque de
  // décalque. Pour un run encore en mémoire elle n'est pas dans l'état, on la
  // retrouve sur le disque.
  const targetForOnion = state.targetUrl || (() => {
    try {
      const f = fs.readdirSync(result.outDir).find((n) => /^target-\d+\.png$/.test(n));
      return f ? toPublicUrl(path.join(result.outDir, f)) : null;
    } catch { return null; }
  })();
  const finalPass = result.passes.at(-1);
  const otherPasses = result.passes.slice(0, -1);
  const fmt = (n) => (n == null ? "—" : n.toLocaleString("fr-FR"));
  const passLabel = (p) => esc(p.label).replace(/ -- /g, " — ");
  const W = result.width, H = result.height;

  // La capture cible fait exactement la taille du rendu : posées côte à côte à
  // la même échelle, les deux pages se comparent directement à l'oeil, et un
  // seul zoom vaut pour les deux. Le PDF d'origine reste accessible à part --
  // son lecteur intégré ne se laisse pas mettre à l'échelle proprement.
  const targetContent = targetForOnion
    ? `<img src="${targetForOnion}" alt="Capture de la page cible" draggable="false">`
    : state.pdfUrl
      ? `<embed src="${state.pdfUrl}#page=${state.page}&toolbar=0" type="application/pdf">`
      : `<p class="empty">Cible indisponible.</p>`;

  res.send(layout("Résultat", {
    crumb,
    status: `<span class="badge done">Terminé</span>`,
    actions: `
      ${state.pdfUrl ? `<a class="btn ghost" href="${state.pdfUrl}#page=${state.page}" target="_blank" rel="noopener">${ICON.pdf}<span>PDF</span></a>` : ""}
      <button type="button" id="editToggle" class="btn">
        <span class="ic-on">${ICON.cursor}</span><span class="ic-off" hidden>${ICON.close}</span>
        <span class="btn-label">Ajuster les images</span>
      </button>
      <a class="btn primary" href="/runs/${runId}/download">${ICON.download}<span>Télécharger le .jsx</span></a>
      ${backIcon}`,
    rail: `<div class="rail-group">
        <p class="rail-title">Passes</p>
        <ul class="passlist">
          ${otherPasses.map((p, i) => `<li><a href="${toPublicUrl(p.htmlPath)}" target="_blank" rel="noopener"><span class="n">${i + 1}</span>${passLabel(p)}</a></li>`).join("")}
          <li class="cur"><span><span class="n">${result.passes.length}</span>${passLabel(finalPass)}</span></li>
        </ul>
      </div>
      <div class="rail-group">
        <p class="rail-title">Ce run</p>
        <dl class="kv">
          <div class="kv-row"><dt>Page</dt><dd>${state.page}</dd></div>
          <div class="kv-row"><dt>Taille</dt><dd>${W}×${H}</dd></div>
          ${result.totalInputTokens != null ? `
            <div class="kv-row"><dt>Tokens in</dt><dd>${fmt(result.totalInputTokens)}</dd></div>
            <div class="kv-row"><dt>Tokens out</dt><dd>${fmt(result.totalOutputTokens)}</dd></div>
            ${result.totalCacheReadTokens || result.totalCacheWriteTokens ? `
              <div class="kv-row"><dt>Cache lu</dt><dd>${fmt(result.totalCacheReadTokens)}</dd></div>
              <div class="kv-row"><dt>Cache écrit</dt><dd>${fmt(result.totalCacheWriteTokens)}</dd></div>` : ""}
          ` : `<div class="kv-row"><dt>Origine</dt><dd>disque</dd></div>`}
        </dl>
      </div>
      ${runsRail(runId)}`,
    main: `<main class="viewport" id="viewport">
      <div class="world" id="world" style="width:${W * 2 + BOARD_GAP}px;height:${H}px">
        <div class="board" id="targetPane" style="left:0;width:${W}px;height:${H}px">
          <p class="frame-name">${state.pdfUrl ? "PDF cible" : "Capture cible"}<span class="fn-sub">page ${state.page}</span></p>
          ${targetContent}
          <div class="board-shield"></div>
        </div>
        <div class="board" id="previewPane" style="left:${W + BOARD_GAP}px;width:${W}px;height:${H}px">
          <p class="frame-name">${passLabel(finalPass)}<span class="fn-sub">rendu live</span></p>
          <iframe id="scaleFrame" title="Preview du composant généré" src="${toPublicUrl(finalPass.htmlPath)}" width="${W}" height="${H}" scrolling="no"></iframe>
          <div class="board-shield"></div>
        </div>
      </div>
      <div class="zoombar">
        <button type="button" id="zOut" title="Dézoomer" aria-label="Dézoomer">${ICON.minus}</button>
        <button type="button" id="zVal" class="zval" title="Revenir à 100 %">100 %</button>
        <button type="button" id="zIn" title="Zoomer" aria-label="Zoomer">${ICON.plus}</button>
        <span class="zsep"></span>
        <button type="button" id="zFit" title="Tout afficher (Maj+1)">${ICON.fit}<span>Ajuster</span></button>
      </div>
      <p class="zoomhint">
        <kbd>glisser</kbd> déplacer &nbsp; <kbd>molette</kbd> défiler<br>
        <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>molette</kbd> zoomer &nbsp; <kbd>Espace</kbd>+glisser
      </p>
    </main>`,
    inspector: `<aside id="editSidebar" aria-label="Ajuster les images">
      <h3>Ajuster</h3>
      <div>
        <p class="sb-label">Sélection</p>
        <div class="sb-box" id="sbSel"><div class="sb-row"><span>Aucune</span></div></div>
      </div>
      ${targetForOnion ? `<div>
        <p class="sb-label">Calque de la cible</p>
        <div class="sb-box">
          <label class="sb-row" style="cursor:pointer">
            <span style="color:var(--tx-2)">Superposer</span>
            <input type="checkbox" id="onionOn">
          </label>
          <input type="range" id="onionOpacity" min="0" max="100" value="45" aria-label="Opacité du calque">
          <div class="sb-row"><span>Opacité</span><span id="onionVal">45 %</span></div>
        </div>
      </div>` : ""}
      <div id="sbSpacing" hidden>
        <p class="sb-label">Espacement</p>
        <div class="sb-box">
          <div style="display:flex;gap:4px;margin-bottom:8px">
            <button type="button" class="sb-btn mode-btn active" data-mode="padding">Intérieur (P)</button>
            <button type="button" class="sb-btn mode-btn" data-mode="margin">Extérieur (M)</button>
          </div>
          <div class="sb-row"><span>Haut</span><input type="number" step="0.1" class="pad-in" data-side="n" aria-label="Haut"></div>
          <div class="sb-row"><span>Droite</span><input type="number" step="0.1" class="pad-in" data-side="e" aria-label="Droite"></div>
          <div class="sb-row"><span>Bas</span><input type="number" step="0.1" class="pad-in" data-side="s" aria-label="Bas"></div>
          <div class="sb-row"><span>Gauche</span><input type="number" step="0.1" class="pad-in" data-side="w" aria-label="Gauche"></div>
        </div>
      </div>
      <div>
        <p class="sb-label">Raccourcis</p>
        <div class="sb-keys">
          <kbd>glisser</kbd> déplacer<br>
          <kbd>poignées</kbd> redimensionner<br>
          <kbd>Maj</kbd> + poignée : centre fixe<br>
          <kbd>←↑↓→</kbd> 1 px &nbsp; <kbd>Maj</kbd>+flèches 10 px<br>
          <kbd>P</kbd> marge intérieure &nbsp; <kbd>M</kbd> extérieure<br>
          <kbd>Ctrl</kbd>+<kbd>Z</kbd> annuler &nbsp; <kbd>Ctrl</kbd>+<kbd>Y</kbd> rétablir<br>
          <kbd>Échap</kbd> désélectionner
        </div>
      </div>
      <div class="sb-actions">
        <p class="sb-status" id="sbStatus">Aucune modification</p>
        <button type="button" id="editSave" class="sb-btn primary" disabled>Enregistrer</button>
        <button type="button" id="editCancel" class="sb-btn">Annuler et quitter</button>
      </div>
    </aside>`,
    script: `<script>
      // ======================= Plan de travail pan/zoom =======================
      // Les deux pages vivent côte à côte à leur taille réelle (${W}x${H} px)
      // dans un monde qu'on translate et met à l'échelle d'un bloc. Comparer
      // deux rendus suppose de pouvoir cadrer librement : voir les deux pages
      // entières, puis plonger au pixel sur un détail sans perdre l'autre.
      const vp = document.getElementById('viewport');
      const world = document.getElementById('world');
      const WORLD_W = ${W * 2 + BOARD_GAP}, WORLD_H = ${H};
      const MIN_Z = 0.02, MAX_Z = 8;
      let z = 1, tx = 0, ty = 0, spaceDown = false;

      const zVal = document.getElementById('zVal');
      const frameNames = () => document.querySelectorAll('.frame-name');

      function apply() {
        world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
        // Les noms de cadre gardent leur taille à l'écran, comme dans un
        // éditeur : illisibles à 20 %, énormes à 400 % sinon.
        for (const n of frameNames()) n.style.transform = 'scale(' + (1 / z) + ')';
        zVal.textContent = Math.round(z * 100) + ' %';
      }
      function clampZ(v) { return Math.max(MIN_Z, Math.min(MAX_Z, v)); }

      function fit(pad) {
        pad = pad == null ? 56 : pad;
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        z = clampZ(Math.min((r.width - pad * 2) / WORLD_W, (r.height - pad * 2) / WORLD_H));
        tx = (r.width - WORLD_W * z) / 2;
        ty = (r.height - WORLD_H * z) / 2;
        apply();
      }
      /** Zoome en gardant fixe le point sous le curseur. */
      function zoomAt(clientX, clientY, factor) {
        const r = vp.getBoundingClientRect();
        const px = clientX - r.left, py = clientY - r.top;
        const nz = clampZ(z * factor);
        if (nz === z) return;
        tx = px - (px - tx) * (nz / z);
        ty = py - (py - ty) * (nz / z);
        z = nz;
        apply();
      }
      function zoomCenter(factor) {
        const r = vp.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
      }

      function onWheel(e, clientX, clientY) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          zoomAt(clientX, clientY, Math.exp(-e.deltaY * 0.0125));
        } else {
          tx -= e.deltaX; ty -= e.deltaY;
          apply();
        }
      }
      vp.addEventListener('wheel', (e) => onWheel(e, e.clientX, e.clientY), { passive: false });

      // --- Déplacement à la souris ---
      let panning = false, sx = 0, sy = 0, stx = 0, sty = 0, panId = null;
      vp.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;
        const board = e.target.closest('.board');
        const onShield = e.target.classList.contains('board-shield');
        // Hors mode édition les écrans de captage couvrent les cadres : on
        // peut donc attraper le plan de travail n'importe où. En mode édition
        // ils s'effacent pour laisser passer la souris vers la preview, et il
        // reste le fond, le bouton du milieu, ou Espace.
        if (!(e.button === 1 || spaceDown || onShield || !board)) return;
        panning = true; panId = e.pointerId;
        sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
        vp.setPointerCapture(e.pointerId);
        vp.classList.add('panning');
        e.preventDefault();
      });
      vp.addEventListener('pointermove', (e) => {
        if (!panning || e.pointerId !== panId) return;
        tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy);
        apply();
      });
      function endPan(e) {
        if (!panning) return;
        panning = false;
        vp.classList.remove('panning');
        try { vp.releasePointerCapture(e.pointerId); } catch {}
      }
      vp.addEventListener('pointerup', endPan);
      vp.addEventListener('pointercancel', endPan);
      vp.addEventListener('contextmenu', (e) => { if (spaceDown) e.preventDefault(); });

      // --- Clavier ---
      function setSpace(down) {
        if (spaceDown === down) return;
        spaceDown = down;
        document.body.classList.toggle('space', down);
      }
      function onKeyDown(e) {
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.code === 'Space') { setSpace(true); e.preventDefault(); return; }
        if (e.shiftKey && e.key === '!') { fit(); e.preventDefault(); return; }   // Maj+1
        if (e.shiftKey && (e.key === '0' || e.key === 'à')) { z = 1; centerOnWorld(); e.preventDefault(); return; }
        if (e.key === '+' || e.key === '=') { zoomCenter(1.2); e.preventDefault(); }
        if (e.key === '-') { zoomCenter(1 / 1.2); e.preventDefault(); }
      }
      function onKeyUp(e) { if (e.code === 'Space') setSpace(false); }
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', () => setSpace(false));

      function centerOnWorld() {
        const r = vp.getBoundingClientRect();
        tx = (r.width - WORLD_W * z) / 2;
        ty = (r.height - WORLD_H * z) / 2;
        apply();
      }

      document.getElementById('zIn').addEventListener('click', () => zoomCenter(1.25));
      document.getElementById('zOut').addEventListener('click', () => zoomCenter(1 / 1.25));
      document.getElementById('zFit').addEventListener('click', () => fit());
      zVal.addEventListener('click', () => { z = 1; centerOnWorld(); });

      // Le panneau d'inspection reprend de la largeur au plan de travail : sans
      // nouveau cadrage, les pages sortent de l'écran par la droite.
      let fitted = false;
      new ResizeObserver(() => { if (!fitted) { fit(); fitted = true; } }).observe(vp);
      fit();

      // La molette et Espace doivent aussi marcher quand le curseur est
      // au-dessus de la preview en mode édition -- l'iframe est de même
      // origine, on écoute donc directement dans son document.
      function bindFrameEvents() {
        try {
          const d = document.getElementById('scaleFrame').contentDocument;
          if (!d || d.__vpBound) return;
          d.__vpBound = true;
          d.addEventListener('wheel', (e) => {
            const r = document.getElementById('scaleFrame').getBoundingClientRect();
            onWheel(e, r.left + e.clientX * z, r.top + e.clientY * z);
          }, { passive: false });
          d.addEventListener('keydown', onKeyDown);
          d.addEventListener('keyup', onKeyUp);
        } catch {}
      }
      document.getElementById('scaleFrame').addEventListener('load', bindFrameEvents);
      bindFrameEvents();

      // ============================ Éditeur d'images ============================
      // L'iframe est servie par ce même serveur, donc même origine : on peut
      // injecter le script d'édition dans son document et récupérer les
      // ajustements par postMessage.
      let currentEdits = null;
      const toggle = document.getElementById('editToggle');
      const toggleLabel = toggle.querySelector('.btn-label');
      const toggleIconOn = toggle.querySelector('.ic-on');
      const toggleIconOff = toggle.querySelector('.ic-off');
      const saveBtn = document.getElementById('editSave');
      const sidebar = document.getElementById('editSidebar');
      const sbSel = document.getElementById('sbSel');
      const cancelBtn = document.getElementById('editCancel');
      // Le statut du panneau latéral remplace l'ancien texte surimprimé sur
      // la preview.
      const hint = document.getElementById('sbStatus');
      let editing = false;

      // Tout le corps est enveloppé : une exception dans un gestionnaire
      // async disparaît silencieusement, et l'utilisateur voit juste un
      // bouton qui "ne fait rien". On affiche donc l'erreur.
      toggle.addEventListener('click', async () => {
       try {
        const frame = document.getElementById('scaleFrame');
        if (editing) {
          editing = false;
          toggleLabel.textContent = 'Ajuster les images';
          toggleIconOn.hidden = false; toggleIconOff.hidden = true;
          toggle.classList.remove('active');
          frame.contentWindow.postMessage({ type: 'cv-deselect' }, '*');
          frame.src = frame.src; // recharge : annule les ajustements non enregistrés
          hint.textContent = 'Aucune modification';
          currentEdits = null;
          document.getElementById('previewPane').classList.remove('editing');
          sidebar.classList.remove('open');
          document.body.classList.remove('editing-open');
          sbSel.innerHTML = '<div class="sb-row"><span>Aucune</span></div>';
          saveBtn.disabled = true;
          return;
        }
        editing = true;
        toggleLabel.textContent = "Quitter l'édition";
        toggleIconOn.hidden = true; toggleIconOff.hidden = false;
        toggle.classList.add('active');
        document.getElementById('previewPane').classList.add('editing');
        sidebar.classList.add('open');
        document.body.classList.add('editing-open');
        // On amène la preview au centre : c'est sur elle qu'on va travailler.
        focusPreview();

        // Les runs générés avant l'ajout des repères data-cvimg n'ont pas
        // d'images identifiables : on re-rend une fois (local, gratuit).
        // Un rendu produit avant l'ajout d'un type de repère laisserait
        // l'édition correspondante indisponible sans le dire : on compare
        // donc la version du schéma d'étiquetage plutôt que la présence
        // d'un attribut particulier.
        const tagsMeta = frame.contentDocument.querySelector('meta[name="cv-tags"]');
        if (!tagsMeta || tagsMeta.content !== '3') {
          hint.textContent = "Préparation de l'éditeur...";
          const rr = await fetch('/runs/${runId}/rerender', { method: 'POST' });
          if (!rr.ok) { hint.textContent = 'Préparation échouée : ' + (await rr.text()); return; }
          await new Promise((resolve) => {
            frame.addEventListener('load', resolve, { once: true });
            frame.src = frame.src.split('?')[0] + '?t=' + Date.now();
          });
          bindFrameEvents();
        }
        // Injecté comme code inline (et non via src) : pas de cache
        // navigateur possible, exécution immédiate, et une erreur de
        // chargement devient visible au lieu d'échouer en silence.
        const code = await (await fetch('/editor-overlay.js?t=' + Date.now())).text();
        const s = frame.contentDocument.createElement('script');
        s.textContent = code;
        frame.contentDocument.body.appendChild(s);

        setTimeout(() => {
          if (editing && !hint.textContent.includes('image(s)')) {
            hint.textContent = "L'éditeur ne s'est pas initialisé — regarde la console du navigateur.";
          }
        }, 2000);
       } catch (err) {
         hint.textContent = 'Erreur : ' + err.message;
         console.error(err);
       }
      });

      /** Cadre la preview seule, à une échelle où les poignées sont saisissables. */
      function focusPreview() {
        const r = vp.getBoundingClientRect();
        z = clampZ(Math.min((r.width - 64) / ${W}, (r.height - 64) / ${H}));
        tx = (r.width - ${W} * z) / 2 - (${W + BOARD_GAP}) * z;
        ty = (r.height - ${H} * z) / 2;
        apply();
      }

      window.addEventListener('message', async (e) => {
        if (!e.data) return;
        if (e.data.type === 'cv-editor-ready') {
          hint.textContent = e.data.count + ' image(s) éditable(s)';
          pushOnion();
        }
        if (e.data.type === 'cv-select') {
          const sel = e.data.sel;
          const spacingBox = document.getElementById('sbSpacing');
          if (!sel) {
            sbSel.innerHTML = '<div class="sb-row"><span>Aucune</span></div>';
            spacingBox.hidden = true;
          } else if (sel.kind === 'text') {
            sbSel.innerHTML = '<div class="sb-row"><span>Texte</span><span>#' + sel.id + '</span></div>'
              + '<div class="sb-row"><span>Contenu</span><span>' + (sel.label || '—') + '</span></div>'
              + (sel.instances > 1 ? '<div class="sb-row"><span>Instances</span><span>' + sel.instances + '</span></div>' : '');
            spacingBox.hidden = false;
            for (const inp of document.querySelectorAll('.pad-in')) inp.value = sel[inp.dataset.side];
            for (const btn of document.querySelectorAll('.mode-btn')) {
              btn.classList.toggle('active', btn.dataset.mode === sel.mode);
            }
          } else {
            sbSel.innerHTML = '<div class="sb-row"><span>Image</span><span>#' + sel.id + '</span></div>'
              + '<div class="sb-row"><span>Largeur</span><span>' + sel.width + ' em</span></div>'
              + '<div class="sb-row"><span>Hauteur</span><span>' + sel.height + ' em</span></div>'
              + '<div class="sb-row"><span>X</span><span>' + sel.left + ' em</span></div>'
              + '<div class="sb-row"><span>Y</span><span>' + sel.top + ' em</span></div>';
            spacingBox.hidden = true;
          }
        }
        if (e.data.type === 'cv-edits') {
          currentEdits = { images: e.data.edits, texts: e.data.textEdits || {}, classes: e.data.classEdits || {} };
          const n = Object.keys(currentEdits.images).length + Object.keys(currentEdits.texts).length
            + Object.keys(currentEdits.classes).length;
          // Après une annulation on peut revenir à zéro modification :
          // le bouton doit alors se désactiver, pas rester actif à vide.
          saveBtn.disabled = n === 0;
          hint.textContent = n ? n + ' modification(s) en attente' : 'Aucune modification';
        }
      });

      // Les raccourcis frappés alors que le focus est sur la page parente
      // (juste après un clic sur un bouton, par exemple) sont relayés à
      // l'iframe, qui détient l'historique.
      document.addEventListener('keydown', (e) => {
        if (!editing) return;
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const frame = document.getElementById('scaleFrame');
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          frame.contentWindow.postMessage({ type: e.shiftKey ? 'cv-redo' : 'cv-undo' }, '*');
        } else if (k === 'y') {
          e.preventDefault();
          frame.contentWindow.postMessage({ type: 'cv-redo' }, '*');
        }
      });

      saveBtn.addEventListener('click', async () => {
        if (!currentEdits) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Enregistrement...';
        const r = await fetch('/runs/${runId}/image-edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits: currentEdits.images, textEdits: currentEdits.texts, classEdits: currentEdits.classes }),
        });
        if (r.ok) { location.reload(); }
        else { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer'; hint.textContent = 'Échec : ' + (await r.text()); }
      });

      cancelBtn.addEventListener('click', () => toggle.click());

      const frameWin = () => document.getElementById('scaleFrame').contentWindow;
      for (const inp of document.querySelectorAll('.pad-in')) {
        inp.addEventListener('change', () => {
          // Les champs sont en em ; l'éditeur travaille en pixels, on
          // convertit via la police de l'élément (16 px par défaut suffirait
          // rarement) -- c'est l'éditeur qui reconvertit proprement.
          frameWin().postMessage({ type: 'cv-setspacing-em', side: inp.dataset.side, em: Number(inp.value) }, '*');
        });
      }
      for (const btn of document.querySelectorAll('.mode-btn')) {
        btn.addEventListener('click', () => {
          frameWin().postMessage({ type: 'cv-setmode', mode: btn.dataset.mode }, '*');
        });
      }

      // Calque de décalque : la capture cible superposée en transparence
      // par-dessus la preview, pour aligner les éléments à l'oeil.
      const onionOn = document.getElementById('onionOn');
      const onionOpacity = document.getElementById('onionOpacity');
      const onionVal = document.getElementById('onionVal');
      function pushOnion() {
        if (!onionOn) return;
        const frame = document.getElementById('scaleFrame');
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage({
          type: 'cv-onion',
          src: ${JSON.stringify(targetForOnion)},
          on: onionOn.checked,
          opacity: Number(onionOpacity.value) / 100,
        }, '*');
        if (onionVal) onionVal.textContent = onionOpacity.value + ' %';
      }
      if (onionOn) {
        onionOn.addEventListener('change', pushOnion);
        onionOpacity.addEventListener('input', pushOnion);
      }
    </script>`,
  }));
});

const PORT = process.env.PIPELINE_PORT || 5051;
app.listen(PORT, () => console.log(`Interface pipeline sur http://localhost:${PORT}`));
