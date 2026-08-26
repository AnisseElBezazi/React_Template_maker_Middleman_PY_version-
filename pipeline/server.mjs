// Interface web locale pour la pipeline Design-to-Code : glisser-déposer un
// PDF, suivi de la génération, puis comparaison PDF cible / preview React
// live côte à côte.
//
// Usage: node server.mjs  (puis ouvrir http://localhost:5050)

import dotenv from "dotenv";
import { ZipArchive } from "archiver";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runPipeline } from "./lib/pipeline.mjs";
import { applyImageEdits, applyTextEdits, applyClassEdits } from "./apply_image_edits.mjs";
import { toDbFormat } from "./to_db_format.mjs";
import { stackedTarget, targetPages } from "./stack_targets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });
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
  // Dimensions : celles d'UNE page, pas de l'empilement -- elles servent de
  // taille de canevas au rendu et à l'éditeur.
  const firstTarget = targetPages(outDir)[0];
  let { width, height } = meta;
  if ((!width || !height) && firstTarget) {
    const buf = fs.readFileSync(firstTarget);
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  }
  // Sur un run multi-pages, on affiche toutes les pages empilées : n'en
  // montrer qu'une donnait l'impression que le reste du template manquait.
  const stacked = firstTarget ? stackedTarget(outDir) : null;
  const targetUrl = stacked ? toPublicUrl(stacked) : null;

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
    effort: meta.effort || (meta.perPass || []).find((p) => p.step === "pass1")?.effort || null,
    result: { outDir, width, height, passes, ...meta.tokens },
  };
}

/** Récupère un run, depuis la mémoire ou, à défaut, depuis le disque. */
function getRun(runId) {
  return runs.get(runId) || rehydrateRun(runId);
}

const IMAGE_IMPORT_RE = /@\/images\/cv-templates\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\.(?:png|jpe?g))/g;
// Les deux formes possibles : `export default function X(...)` ou une
// déclaration suivie de `export default X` en fin de fichier.
const COMPONENT_NAME_RE = /export\s+default\s+(?:function\s+)?(\w+)/;

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
  block: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.25" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.6 1.8"/></svg>`,
  layers: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75 1.75 5 8 8.25 14.25 5 8 1.75Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m1.75 8.75 6.25 3.25 6.25-3.25" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  think: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><circle cx="5.2" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="10.8" cy="8" r="1" fill="currentColor"/></svg>`,
  write: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.4 2.6 13.4 5.6 5.9 13.1l-3.4.4.4-3.4 7.5-7.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  warn: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.25 14.5 13.5h-13L8 2.25Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.5v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.25H2.25V6M10 2.25h3.75V6M6 13.75H2.25V10M10 13.75h3.75V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  hand: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.25 7.5V3.9a1.15 1.15 0 0 1 2.3 0v3.1m0-.6V2.9a1.15 1.15 0 0 1 2.3 0v4.1m0-.9a1.15 1.15 0 0 1 2.3 0v1.4m-9.2-.4a1.15 1.15 0 0 0-1.2 1.15c0 .3.1.6.3.85l2.4 3.1a4.2 4.2 0 0 0 3.3 1.6h.6a4.1 4.1 0 0 0 4.1-4.1V7.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  text: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.25h10M8 3.25v9.5M5.75 12.75h4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  image: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5.6" cy="6.4" r="1.1" fill="currentColor"/><path d="m2.4 11.9 3.3-3.1a1 1 0 0 1 1.4 0l2.1 2 1.3-1.2a1 1 0 0 1 1.4 0l1.8 1.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  block: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.75 1.75v12.5M11.25 1.75v12.5M1.75 4.75h12.5M1.75 11.25h12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  onion: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.1" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.9a6.1 6.1 0 0 1 0 12.2V1.9Z" fill="currentColor"/></svg>`,
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
  input.num, select.num {
    width:60px; height:28px; padding:0 8px; border:1px solid var(--line-2); border-radius:var(--r);
    background:#fff; color:var(--tx); font-family:var(--mono); font-size:11.5px;
    text-align:right; font-variant-numeric:tabular-nums;
  }
  select.num { width:auto; padding-right:4px; text-align:left; cursor:pointer; }
  input.num:focus, select.num:focus { outline:none; border-color:var(--sel); box-shadow:0 0 0 2px var(--sel-soft); }

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
  /* Coupure entre deux pages. Le rendu et la cible empilent leurs pages avec
     24px de blanc, invisible sur du papier blanc : on repeint cette bande à
     la couleur du canevas et on y projette l'ombre des deux feuilles, pour
     qu'une fin de page se lise d'un coup d'oeil. Purement visuel -- ni le
     rendu ni le diff ne sont touchés. */
  .page-gap {
    position:absolute; left:0; right:0; z-index:2; pointer-events:none;
    background:var(--canvas);
    box-shadow:inset 0 7px 8px -8px rgba(0,0,0,.38), inset 0 -7px 8px -8px rgba(0,0,0,.38);
  }
  /* Trait net sur l'arête de chaque feuille, d'épaisseur constante à l'écran
     quel que soit le zoom (--inv-z est posé par le contrôleur de zoom). La
     bande porte la coupure de près, ces traits la portent de loin. */
  .page-gap::before, .page-gap::after {
    content:""; position:absolute; left:0; right:0;
    height:calc(1px * var(--inv-z, 1)); background:rgba(0,0,0,.42);
  }
  .page-gap::before { top:0; }
  .page-gap::after { bottom:0; }
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
  body.tool-edit .board-shield { pointer-events:none; }
  body.tool-edit.space .board-shield { pointer-events:auto; }
  body.tool-edit #targetPane .board-shield { pointer-events:auto; }
  body.tool-edit .viewport { cursor:default; }
  body.tool-edit.space .viewport { cursor:grab; }
  body.tool-edit.space .viewport.panning { cursor:grabbing; }
  #previewPane.editing { box-shadow:var(--shadow-sheet), 0 0 0 1.5px var(--sel); }
  #previewPane.editing .frame-name { color:var(--sel); font-weight:600; }
  body.tool-edit #targetPane { opacity:.45; }

  /* Pastille de zoom : flotte au-dessus du plan de travail, comme les contrôles
     de vue d'un éditeur. */
  /* Barre d'outils flottante : elle porte le mode de travail et le cadrage,
     les deux choses qu'on change sans arrêt en comparant deux rendus. */
  .dock {
    position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
    display:flex; align-items:center; gap:2px; padding:3px;
    background:#fff; border:1px solid var(--line); border-radius:9px;
    box-shadow:var(--shadow-pop); z-index:10; user-select:none; max-width:calc(100% - 32px);
  }
  .dock button {
    height:28px; min-width:28px; padding:0 7px; border:none; background:transparent;
    color:var(--tx-2); border-radius:6px; cursor:pointer; font-size:11px; font-weight:500;
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    transition:background .14s ease, color .14s ease;
  }
  .dock button:hover:not(:disabled) { background:var(--hover); color:var(--tx); }
  .dock button[aria-pressed="true"] { background:var(--sel); color:#fff; }
  .dock button[aria-pressed="true"]:hover { background:#0b86e0; color:#fff; }
  .dock button:disabled { color:#c2c2c2; cursor:not-allowed; }
  /* Un outil pas encore livré se signale, plutôt que de rester un bouton mort
     dont on ne sait pas s'il est cassé. */
  .dock button.soon { position:relative; }
  .dock button.soon::after {
    content:""; position:absolute; top:4px; right:4px; width:4px; height:4px;
    border-radius:50%; background:var(--warn);
  }
  .dock .zval {
    min-width:50px; font-family:var(--mono); font-size:11px; color:var(--tx);
    font-variant-numeric:tabular-nums;
  }
  .dock .zsep { width:1px; height:18px; background:var(--line); margin:0 4px; flex:none; }
  .zoomhint {
    position:absolute; bottom:60px; left:50%; transform:translateX(-50%);
    z-index:10; pointer-events:none; white-space:nowrap;
    font-size:10.5px; color:var(--tx-3); line-height:1.7;
    transition:opacity .45s ease;
  }
  body.hint-gone .zoomhint { opacity:0; }
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
  #editSidebar .sb-row.scrubbable span:first-child { cursor:ew-resize; user-select:none; }
  #editSidebar .sb-row.scrubbable:hover span:first-child { color:var(--sel); }
  body.scrubbing, body.scrubbing * { cursor:ew-resize !important; user-select:none !important; }
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
            <label for="pageInput">Page à traiter<span class="hint">Un numéro de page, ou « all » pour tout le template.</span></label>
            <input type="text" class="num" name="page" id="pageInput" value="1" pattern="[0-9]+|all|ALL" title="Un numéro de page, ou all">
          </div>

          <div class="field-row">
            <label for="effortInput">Raisonnement de la passe 1<span class="hint">Plus haut = meilleure analyse, mais le raisonnement est facturé comme de la sortie.</span></label>
            <select class="num" name="effort" id="effortInput">
              <option value="low">low — rapide</option>
              <option value="high" selected>high — par défaut</option>
              <option value="max">max — template complexe</option>
            </select>
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
  // "all" = reproduire le template entier (toutes les pages du PDF).
  const rawPage = String(req.body.page || "1").trim().toLowerCase();
  const pageNumber = rawPage === "all" ? "all" : (parseInt(rawPage, 10) || 1);
  // Effort de raisonnement de la passe 1, choisi dans le formulaire.
  const rawEffort = String(req.body.effort || "high").trim().toLowerCase();
  const pass1Effort = ["low", "high", "max"].includes(rawEffort) ? rawEffort : "high";

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
    effort: pass1Effort,
  };
  runs.set(runId, state);

  runPipeline({
    pdfPath: pdfFile.path,
    pageNumber,
    pass1Effort,
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
            effort: state.effort,
            width: result.width,
            height: result.height,
            finishedAt: new Date().toISOString(),
            tokens: {
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              totalCacheReadTokens: result.totalCacheReadTokens,
              totalCacheWriteTokens: result.totalCacheWriteTokens,
            },
            // Détail par passe : indispensable pour savoir laquelle coûte
            // cher plutôt que de l'estimer.
            perPass: result.perPassUsage,
            costUsd: (result.perPassUsage || []).reduce((sum, p) => sum + p.costUsd, 0),
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

  // Conversion vers le format de l'app : fichier évalué comme corps de
  // fonction (React/engine injectés) et images lues depuis la base via
  // `assets`. La preview, elle, continue de fonctionner avec les imports.
  let db = null;
  try {
    db = toDbFormat(jsxCode);
  } catch (err) {
    db = { error: err.message };
  }

  const assetLines = db.assets?.length
    ? db.assets.map((a) => `  ${a.key.padEnd(16)} <- assets/${a.key}${path.extname(a.file) || ".png"}`).join("\n")
    : "  (aucune image)";

  const readme = `Composant généré par la pipeline Design-to-Code -- run ${req.params.id}, page ${state.page}.

CONTENU
- ${componentName}.jsx        le composant AU FORMAT DE L'APP : évalué comme corps de
                              fonction recevant React et engine, images lues dans l'objet
                              assets. C'est ce fichier qui va en base.
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
- Le CSS éventuel (xxxSmartCv.css) n'est pas généré : à écrire si le template a besoin
  de classes hors Tailwind, comme l'exemple Visian.
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
            ${state.effort ? `<div class="kv-row"><dt>Raisonnement</dt><dd>${esc(state.effort)}</dd></div>` : ""}
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
      const stacked = stackedTarget(result.outDir);
      return stacked ? toPublicUrl(stacked) : null;
    } catch { return null; }
  })();
  const finalPass = result.passes.at(-1);
  const otherPasses = result.passes.slice(0, -1);
  const fmt = (n) => (n == null ? "—" : n.toLocaleString("fr-FR"));
  const passLabel = (p) => esc(p.label).replace(/ -- /g, " — ");
  const W = result.width, H = result.height;
  // Hauteurs RÉELLES des deux planches. Sur un run multi-pages elles
  // diffèrent de la hauteur d'une page -- et l'une de l'autre, puisque le
  // moteur de pagination émet autant de pages que les données l'exigent, pas
  // forcément autant que la cible en compte. Les figer à H écrasait la cible
  // empilée dans la hauteur d'une seule page.
  const pngHeight = (file) => {
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      fs.closeSync(fd);
      return buf.readUInt32BE(20) || null;
    } catch { return null; }
  };
  // Bandes de coupure : une par jointure entre deux pages, positionnée sur
  // les hauteurs réelles -- une page rendue ne fait pas forcément la hauteur
  // du canevas (contenu qui déborde), donc on ne peut pas les déduire.
  const PAGE_GAP = 24;
  const gapStrips = (heights) => heights.slice(0, -1)
    .map((_, i) => heights.slice(0, i + 1).reduce((a, b) => a + b, 0) + PAGE_GAP * i)
    .map((top) => `<div class="page-gap" style="top:${top}px;height:${PAGE_GAP}px"></div>`)
    .join("");
  const targetGaps = gapStrips(targetPages(result.outDir).map((f) => pngHeight(f) || H));
  const previewGaps = gapStrips(
    fs.readdirSync(result.outDir)
      .filter((f) => /^final-page-\d+\.png$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
      .map((f) => pngHeight(path.join(result.outDir, f)) || H)
  );

  const targetH = (targetForOnion && pngHeight(path.join(result.outDir, path.basename(targetForOnion)))) || H;
  const previewH = pngHeight(finalPass.pngPath) || H;
  const worldH = Math.max(targetH, previewH);

  // La capture cible fait exactement la taille du rendu : posées côte à côte à
  // la même échelle, les deux pages se comparent directement à l'oeil, et un
  // seul zoom vaut pour les deux. Le PDF d'origine reste accessible à part --
  // son lecteur intégré ne se laisse pas mettre à l'échelle proprement.
  const targetContent = targetForOnion
    ? `<img src="${targetForOnion}" alt="Capture de la page cible" draggable="false">`
    : state.pdfUrl
      ? `<embed src="${state.pdfUrl}${String(state.page).toLowerCase() === "all" ? "#toolbar=0" : `#page=${state.page}&toolbar=0`}" type="application/pdf">`
      : `<p class="empty">Cible indisponible.</p>`;

  res.send(layout("Résultat", {
    crumb,
    status: `<span class="badge done">Terminé</span>`,
    actions: `
      ${state.pdfUrl ? `<a class="btn ghost" href="${state.pdfUrl}${String(state.page).toLowerCase() === "all" ? "" : `#page=${state.page}`}" target="_blank" rel="noopener">${ICON.pdf}<span>PDF</span></a>` : ""}
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
          ${state.effort ? `<div class="kv-row"><dt>Raisonnement</dt><dd>${esc(state.effort)}</dd></div>` : ""}
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
      <div class="world" id="world" style="width:${W * 2 + BOARD_GAP}px;height:${worldH}px">
        <div class="board" id="targetPane" style="left:0;width:${W}px;height:${targetH}px">
          <p class="frame-name">${state.pdfUrl ? "PDF cible" : "Capture cible"}<span class="fn-sub">${String(state.page).toLowerCase() === "all" ? `${targetPages(result.outDir).length} pages` : `page ${state.page}`}</span></p>
          ${targetContent}
          ${targetGaps}
          <div class="board-shield"></div>
        </div>
        <div class="board" id="previewPane" style="left:${W + BOARD_GAP}px;width:${W}px;height:${previewH}px">
          <p class="frame-name">${passLabel(finalPass)}<span class="fn-sub">rendu live</span></p>
          <iframe id="scaleFrame" title="Preview du composant généré" src="${toPublicUrl(finalPass.htmlPath)}" width="${W}" height="${previewH}" scrolling="no"></iframe>
          ${previewGaps}
          <div class="board-shield"></div>
        </div>
      </div>
      <div class="dock" role="toolbar" aria-label="Outils">
        <button type="button" class="tool" data-tool="none" aria-pressed="true" title="Parcourir — H">${ICON.hand}</button>
        <button type="button" class="tool" data-tool="all" aria-pressed="false" title="Sélection — V">${ICON.cursor}</button>
        <button type="button" class="tool" data-tool="text" aria-pressed="false" title="Texte — T">${ICON.text}</button>
        <button type="button" class="tool" data-tool="img" aria-pressed="false" title="Image — I">${ICON.image}</button>
        <button type="button" class="tool" data-tool="div" aria-pressed="false" title="Bloc (conteneur) — B">${ICON.block}</button>
        <span class="zsep"></span>
        <button type="button" id="onionBtn" aria-pressed="false" title="Calque de la cible — O"${targetForOnion ? "" : " disabled"}>${ICON.onion}</button>
        <span class="zsep"></span>
        <button type="button" id="zOut" title="Dézoomer" aria-label="Dézoomer">${ICON.minus}</button>
        <button type="button" id="zVal" class="zval" title="Revenir à 100 %">100 %</button>
        <button type="button" id="zIn" title="Zoomer" aria-label="Zoomer">${ICON.plus}</button>
        <button type="button" id="zFit" title="Tout afficher — Maj+1" aria-label="Tout afficher">${ICON.fit}</button>
      </div>
      <p class="zoomhint">
        <kbd>glisser</kbd> déplacer &nbsp; <kbd>molette</kbd> défiler &nbsp;
        <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>molette</kbd> zoomer &nbsp; <kbd>Espace</kbd>+glisser
      </p>
    </main>`,
    inspector: `<aside id="editSidebar" aria-label="Ajuster les images">
      <h3>Ajuster</h3>
      <div>
        <p class="sb-label">Sélection</p>
        <div class="sb-box" id="sbSel"><div class="sb-row"><span>Aucune</span></div></div>
      </div>
      ${targetForOnion ? `<div id="sbOnion" hidden>
        <p class="sb-label">Calque de la cible</p>
        <div class="sb-box">
          <input type="range" id="onionOpacity" min="0" max="100" value="45" aria-label="Opacité du calque" style="margin-top:0">
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
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Haut</span><input type="number" step="0.1" class="pad-in" data-side="n" aria-label="Haut"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Droite</span><input type="number" step="0.1" class="pad-in" data-side="e" aria-label="Droite"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Bas</span><input type="number" step="0.1" class="pad-in" data-side="s" aria-label="Bas"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Gauche</span><input type="number" step="0.1" class="pad-in" data-side="w" aria-label="Gauche"></div>
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
      const WORLD_W = ${W * 2 + BOARD_GAP}, WORLD_H = ${worldH};
      // La barre du bas flotte au-dessus du plan de travail : le cadrage lui
      // réserve sa hauteur, sinon elle masque le pied des pages.
      const MAX_Z = 8, FIT_PAD = 56, DOCK_SAFE = 52;
      // Le plan de travail est borné : au-delà des pages, on ne peut découvrir
      // qu'une marge de vide, jamais les perdre de vue. Sans ça un glisser un
      // peu vif laisse un écran gris, et il faut retrouver son chemin à
      // l'aveugle. La marge est proportionnelle à la fenêtre pour rester
      // franchissable au zoom fort comme au zoom faible.
      const OVERSCROLL = 0.3;
      let z = 1, tx = 0, ty = 0, spaceDown = false;

      const zVal = document.getElementById('zVal');
      const frameNames = () => document.querySelectorAll('.frame-name');

      /** Échelle à laquelle les deux pages tiennent entièrement à l'écran. */
      function fitZoom(pad) {
        pad = pad == null ? FIT_PAD : pad;
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return 1;
        return Math.max(0.02, Math.min((r.width - pad * 2) / WORLD_W, (r.height - DOCK_SAFE - pad * 2) / WORLD_H));
      }
      // Dézoomer au-delà de la moitié du cadrage complet ne montre plus rien
      // d'utile : c'est la borne basse.
      function clampZ(v) { return Math.max(fitZoom() * 0.5, Math.min(MAX_Z, v)); }

      /** Ramène le déplacement dans les bornes du plan de travail. */
      function clampPan() {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const m = Math.min(r.width, r.height) * OVERSCROLL;
        // Les deux bornes se croisent selon que les pages sont plus larges ou
        // plus étroites que la fenêtre ; min/max remet l'intervalle à
        // l'endroit dans les deux cas. Le cadrage complet, lui, tombe toujours
        // dedans -- il n'est jamais recalé.
        const bx = [m, r.width - WORLD_W * z - m];
        const by = [m, r.height - WORLD_H * z - m];
        tx = Math.min(Math.max(tx, Math.min(bx[0], bx[1])), Math.max(bx[0], bx[1]));
        ty = Math.min(Math.max(ty, Math.min(by[0], by[1])), Math.max(by[0], by[1]));
      }

      function apply() {
        clampPan();
        world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
        // Les noms de cadre gardent leur taille à l'écran, comme dans un
        // éditeur : illisibles à 20 %, énormes à 400 % sinon.
        for (const n of frameNames()) n.style.transform = 'scale(' + (1 / z) + ')';
        // Les traits de coupure gardent eux aussi une épaisseur d'écran
        // constante : à 10 % de zoom, une bande de 24px n'en fait plus que 2
        // et la fin de page redevient invisible.
        world.style.setProperty('--inv-z', String(1 / z));
        zVal.textContent = Math.round(z * 100) + ' %';
      }

      function fit(pad) {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        z = fitZoom(pad);
        tx = (r.width - WORLD_W * z) / 2;
        ty = (r.height - DOCK_SAFE - WORLD_H * z) / 2;
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
          zoomAt(clientX, clientY, Math.exp(-e.deltaY * 0.0025));
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
        if (e.target.closest('.dock')) return;
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

      // Cliquer à l'extérieur de la zone du CV / des contrôles désélectionne l'élément courant
      document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && (e.target.closest('#scaleFrame') || e.target.closest('#editSidebar') || e.target.closest('.dock'))) {
          return;
        }
        post({ type: 'cv-deselect' });
      });

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
        if (e.key === '+' || e.key === '=') { zoomCenter(1.2); e.preventDefault(); return; }
        if (e.key === '-') { zoomCenter(1 / 1.2); e.preventDefault(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        const byKey = { h: 'none', v: 'all', t: 'text', i: 'img', b: 'div' };
        if (byKey[k]) { setTool(byKey[k]); e.preventDefault(); return; }
        if (k === 'o') { setOnion(!onionOn); e.preventDefault(); }
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

      // Ouvrir le panneau d'inspection reprend de la largeur au plan de travail.
      // Recadrer d'office ferait sauter la vue : on décale de la moitié de ce
      // qui a été pris ou rendu, ce qui garde le point central sous les yeux.
      // La référence est conservée : un ResizeObserver dont la seule attache est
      // interne finit ramassé par le GC, et l'observation s'arrête en silence
      // après le tout premier appel.
      let lastW = 0, lastH = 0;
      const vpResize = new ResizeObserver(() => {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (!lastW) { fit(); }
        else { tx += (r.width - lastW) / 2; ty += (r.height - lastH) / 2; apply(); }
        lastW = r.width; lastH = r.height;
      });
      vpResize.observe(vp);

      // L'aide au pilotage a fait son office dès le premier geste.
      let hintGone = false;
      function dismissHint() {
        if (hintGone) return;
        hintGone = true;
        document.body.classList.add('hint-gone');
      }
      vp.addEventListener('wheel', dismissHint, { passive: true });
      vp.addEventListener('pointerdown', dismissHint);
      setTimeout(dismissHint, 9000);

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

      // ============================== Outils ==============================
      // La barre du bas porte le mode de travail. Changer d'outil ne détruit
      // jamais rien : seul « Annuler et quitter » recharge la preview. Le
      // script d'édition est injecté à la première demande et reste en place
      // ensuite -- l'outil « Parcourir » le laisse simplement inerte.
      let currentEdits = null;
      let tool = 'none';
      let onionOn = false;
      let overlayReady = false, overlayBusy = false, readyResolve = null;

      const saveBtn = document.getElementById('editSave');
      const sidebar = document.getElementById('editSidebar');
      const sbSel = document.getElementById('sbSel');
      const sbOnion = document.getElementById('sbOnion');
      const cancelBtn = document.getElementById('editCancel');
      const onionBtn = document.getElementById('onionBtn');
      const hint = document.getElementById('sbStatus');
      const frameEl = () => document.getElementById('scaleFrame');
      const isEditTool = (t) => t === 'all' || t === 'text' || t === 'img' || t === 'div';
      const post = (msg) => { const f = frameEl(); if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); };

      // Recharger l'iframe emporte le script injecté avec elle.
      frameEl().addEventListener('load', () => { overlayReady = false; });

      function waitReady(ms) {
        return new Promise((resolve) => {
          readyResolve = resolve;
          setTimeout(() => { if (readyResolve === resolve) { readyResolve = null; resolve(false); } }, ms);
        });
      }

      /** Injecte le script d'édition si besoin. needTags n'est vrai que pour
       *  les outils qui sélectionnent : le calque, lui, n'a pas besoin des
       *  repères posés dans le rendu. */
      async function ensureOverlay(needTags) {
        if (overlayReady) return true;
        if (overlayBusy) return false;
        overlayBusy = true;
        try {
          const frame = frameEl();
          // Les runs générés avant l'ajout des repères data-cvimg n'ont pas
          // d'éléments identifiables : on re-rend une fois (local, gratuit).
          // Un rendu produit avant l'ajout d'un type de repère laisserait
          // l'édition correspondante indisponible sans le dire : on compare
          // donc la version du schéma d'étiquetage plutôt que la présence
          // d'un attribut particulier.
          if (needTags) {
            const meta = frame.contentDocument.querySelector('meta[name="cv-tags"]');
            if (!meta || meta.content !== '4') {
              hint.textContent = "Préparation de l'éditeur...";
              const rr = await fetch('/runs/${runId}/rerender', { method: 'POST' });
              if (!rr.ok) { hint.textContent = 'Préparation échouée : ' + (await rr.text()); return false; }
              await new Promise((resolve) => {
                frame.addEventListener('load', resolve, { once: true });
                frame.src = frame.src.split('?')[0] + '?t=' + Date.now();
              });
              bindFrameEvents();
            }
          }
          // Injecté comme code inline (et non via src) : pas de cache
          // navigateur possible, exécution immédiate, et une erreur de
          // chargement devient visible au lieu d'échouer en silence.
          const code = await (await fetch('/editor-overlay.js?t=' + Date.now())).text();
          const el = frame.contentDocument.createElement('script');
          el.textContent = code;
          const ready = waitReady(4000);
          frame.contentDocument.body.appendChild(el);
          if (!await ready) {
            hint.textContent = "L'éditeur ne s'est pas initialisé — regarde la console du navigateur.";
            return false;
          }
          return true;
        } catch (err) {
          // Une exception dans un gestionnaire async disparaît silencieusement,
          // et l'utilisateur voit juste un bouton qui « ne fait rien ».
          hint.textContent = 'Erreur : ' + err.message;
          console.error(err);
          return false;
        } finally {
          overlayBusy = false;
        }
      }

      async function setTool(next) {
        if (next === tool) return;
        if (isEditTool(next)) {
          if (!await ensureOverlay(true)) { syncDock(); return; }
          // Première entrée en édition : on amène la preview au centre, c'est
          // sur elle qu'on va travailler.
          if (!isEditTool(tool)) focusPreview();
        }
        tool = next;
        post({ type: 'cv-settool', tool });
        syncDock();
      }

      async function setOnion(on) {
        if (on && !await ensureOverlay(false)) { syncDock(); return; }
        onionOn = on;
        pushOnion();
        syncDock();
      }

      function syncDock() {
        for (const b of document.querySelectorAll('.dock .tool')) {
          b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
        }
        if (onionBtn) onionBtn.setAttribute('aria-pressed', String(onionOn));
        const editing = isEditTool(tool);
        document.body.classList.toggle('tool-edit', editing);
        document.getElementById('previewPane').classList.toggle('editing', editing);
        if (sbOnion) sbOnion.hidden = !onionOn;
        // Le panneau reste ouvert tant qu'il a quelque chose à montrer : un
        // outil actif, un réglage de calque, ou des modifications à enregistrer.
        const pending = currentEdits
          ? Object.keys(currentEdits.images).length + Object.keys(currentEdits.texts).length + Object.keys(currentEdits.classes).length
          : 0;
        const open = editing || onionOn || pending > 0;
        sidebar.classList.toggle('open', open);
        document.body.classList.toggle('editing-open', open);
        if (!editing) {
          post({ type: 'cv-deselect' });
          sbSel.innerHTML = '<div class="sb-row"><span>Aucune</span></div>';
          document.getElementById('sbSpacing').hidden = true;
        }
      }

      for (const b of document.querySelectorAll('.dock .tool')) {
        b.addEventListener('click', () => setTool(b.dataset.tool));
      }
      if (onionBtn) onionBtn.addEventListener('click', () => setOnion(!onionOn));

      /** Cadre la preview seule, à une échelle où les poignées sont saisissables. */
      function focusPreview() {
        const r = vp.getBoundingClientRect();
        z = clampZ(Math.min((r.width - 64) / ${W}, (r.height - DOCK_SAFE - 64) / ${previewH}));
        tx = (r.width - ${W} * z) / 2 - (${W + BOARD_GAP}) * z;
        ty = (r.height - DOCK_SAFE - ${previewH} * z) / 2;
        apply();
      }

      window.addEventListener('message', async (e) => {
        if (!e.data) return;
        if (e.data.type === 'cv-editor-ready') {
          overlayReady = true;
          if (readyResolve) { const r = readyResolve; readyResolve = null; r(true); }
          const parts = [];
          if (e.data.count) parts.push(e.data.count + ' image' + (e.data.count > 1 ? 's' : ''));
          if (e.data.texts) parts.push(e.data.texts + ' texte' + (e.data.texts > 1 ? 's' : ''));
          hint.textContent = parts.length ? parts.join(' · ') + ' éditables' : "Rien d'éditable dans ce rendu";
          post({ type: 'cv-settool', tool });
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
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Largeur</span><input type="number" step="0.1" min="0" class="pad-in img-in" data-prop="width" value="' + sel.width + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Hauteur</span><input type="number" step="0.1" min="0" class="pad-in img-in" data-prop="height" value="' + sel.height + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>X</span><input type="number" step="0.1" class="pad-in img-in" data-prop="left" value="' + sel.left + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Y</span><input type="number" step="0.1" class="pad-in img-in" data-prop="top" value="' + sel.top + '"></div>';
            spacingBox.hidden = true;
          }
          bindScrubbers();
        }
        if (e.data.type === 'cv-edits') {
          currentEdits = { images: e.data.edits, texts: e.data.textEdits || {}, classes: e.data.classEdits || {} };
          const n = Object.keys(currentEdits.images).length + Object.keys(currentEdits.texts).length
            + Object.keys(currentEdits.classes).length;
          // Après une annulation on peut revenir à zéro modification :
          // le bouton doit alors se désactiver, pas rester actif à vide.
          saveBtn.disabled = n === 0;
          hint.textContent = n ? n + ' modification(s) en attente' : 'Aucune modification';
          syncDock();
        }
      });

      // Les raccourcis frappés alors que le focus est sur la page parente
      // (juste après un clic sur un bouton, par exemple) sont relayés à
      // l'iframe, qui détient l'historique.
      document.addEventListener('keydown', (e) => {
        if (!isEditTool(tool)) return;
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

      cancelBtn.addEventListener('click', () => {
        const frame = frameEl();
        frame.src = frame.src; // recharge : annule les ajustements non enregistrés
        currentEdits = null;
        tool = 'none';
        onionOn = false;
        saveBtn.disabled = true;
        hint.textContent = 'Aucune modification';
        syncDock();
      });

      const frameWin = () => document.getElementById('scaleFrame').contentWindow;
      function bindScrubbers() {
        document.querySelectorAll('#editSidebar .sb-row.scrubbable').forEach((row) => {
          if (row.__scrubBound) return;
          row.__scrubBound = true;
          const input = row.querySelector('input');
          if (!input) return;
          const label = row.querySelector('span:first-child');

          const triggerChange = () => {
            if (input.classList.contains('img-in')) {
              frameWin().postMessage({ type: 'cv-setgeom-em', [input.dataset.prop]: Number(input.value) }, '*');
            } else {
              frameWin().postMessage({ type: 'cv-setspacing-em', side: input.dataset.side, em: Number(input.value) }, '*');
            }
          };

          // La saisie manuelle au clavier fonctionne à 100% sans bloquer le focus
          input.addEventListener('input', triggerChange);
          input.addEventListener('change', triggerChange);

          // Le glisser-déposer (scrubbing) s'effectue uniquement sur le libellé (span)
          if (label) {
            let isDragging = false;
            let startX = 0;
            let startVal = 0;

            label.addEventListener('pointerdown', (e) => {
              isDragging = true;
              startX = e.clientX;
              startVal = Number(input.value) || 0;
              label.setPointerCapture(e.pointerId);
              document.body.classList.add('scrubbing');
              e.preventDefault();
            });

            label.addEventListener('pointermove', (e) => {
              if (!isDragging) return;
              const dx = e.clientX - startX;
              const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
              let newVal = Math.round((startVal + dx * step * 0.5) * 100) / 100;
              if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
              input.value = newVal;
              triggerChange();
            });

            const endDrag = (e) => {
              if (!isDragging) return;
              isDragging = false;
              document.body.classList.remove('scrubbing');
              try { label.releasePointerCapture(e.pointerId); } catch {}
            };

            label.addEventListener('pointerup', endDrag);
            label.addEventListener('pointercancel', endDrag);

            label.addEventListener('wheel', (e) => {
              e.preventDefault();
              const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
              const delta = e.deltaY < 0 ? step : -step;
              let newVal = Math.round(((Number(input.value) || 0) + delta) * 100) / 100;
              if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
              input.value = newVal;
              triggerChange();
            }, { passive: false });
          }

          // Molette sur l'input directement
          input.addEventListener('wheel', (e) => {
            if (document.activeElement === input) return;
            e.preventDefault();
            const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
            const delta = e.deltaY < 0 ? step : -step;
            let newVal = Math.round(((Number(input.value) || 0) + delta) * 100) / 100;
            if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
            input.value = newVal;
            triggerChange();
          }, { passive: false });
        });
      }
      bindScrubbers();

      for (const btn of document.querySelectorAll('.mode-btn')) {
        btn.addEventListener('click', () => {
          frameWin().postMessage({ type: 'cv-setmode', mode: btn.dataset.mode }, '*');
        });
      }

      // Calque de décalque : la capture cible superposée en transparence
      // par-dessus la preview, pour aligner les éléments à l'oeil.
      const onionOpacity = document.getElementById('onionOpacity');
      const onionVal = document.getElementById('onionVal');
      function pushOnion() {
        if (!onionOpacity) return;
        post({
          type: 'cv-onion',
          src: ${JSON.stringify(targetForOnion)},
          on: onionOn,
          opacity: Number(onionOpacity.value) / 100,
        });
        if (onionVal) onionVal.textContent = onionOpacity.value + ' %';
      }
      if (onionOpacity) onionOpacity.addEventListener('input', pushOnion);

      syncDock();
    </script>`,
  }));
});

const PORT = process.env.PIPELINE_PORT || 5050;
app.listen(PORT, () => console.log(`Interface pipeline sur http://localhost:${PORT}`));
