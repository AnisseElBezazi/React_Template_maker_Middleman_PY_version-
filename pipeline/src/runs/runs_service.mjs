// État des runs : ce qui vit en mémoire, ce qu'on relit du disque, et
// l'historique. Ne touche jamais à la requête HTTP.

import fs from "fs";
import path from "path";
import { OUT_ROOT, UPLOADS_ROOT, toPublicUrl } from "../shared/paths_shared.mjs";
import { stackedTarget, targetPages } from "../rendering/stack_targets.mjs";


/** @type {Map<string, {status: string, step: string, message: string, log: {step:string,message:string}[], result: any, error: string|null, pdfUrl: string, page: number}>} */
export const runs = new Map();

export const PASS_LABELS = {
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

  const type = meta.type || "jsx";
  if (type === "jinja") {
    if (!fs.existsSync(path.join(outDir, "result.docx"))) return null;
    return {
      status: "done",
      step: "done",
      message: "Rechargé depuis le disque.",
      log: [],
      error: null,
      restored: true,
      type: "jinja",
      pdfUrl: meta.pdfUrl && fs.existsSync(path.join(UPLOADS_ROOT, path.basename(meta.pdfUrl))) ? meta.pdfUrl : null,
      result: { outDir, docxPath: path.join(outDir, "result.docx"), jsonPath: path.join(outDir, "data.json") },
    };
  }

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
    type: "jsx",
    result: { outDir, width, height, passes, ...meta.tokens },
  };
}

/** Récupère un run, depuis la mémoire ou, à défaut, depuis le disque. */
export function getRun(runId) {
  return runs.get(runId) || rehydrateRun(runId);
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
    .filter((d) => fs.existsSync(path.join(OUT_ROOT, d, "attempt1.jsx")) || fs.existsSync(path.join(OUT_ROOT, d, "result.docx")))
    .map((d) => ({ d, t: runTime(d) }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.d);
}

export function runWhen(dirName) {
  const t = runTime(dirName);
  if (!t) return dirName;
  return new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Historique prêt à afficher : le rail de gauche n'a pas à savoir comment un
 * identifiant se transforme en date lisible. */
export function listRuns(limit = 14) {
  return pastRuns(limit).map((id) => ({ id, when: runWhen(id) }));
}
