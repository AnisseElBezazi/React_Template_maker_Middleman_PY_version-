// CLI pour la pipeline Design-to-Code (voir lib/pipeline.mjs pour la logique).
// Usage: node run_pipeline.mjs <pdf_path> [page_number] [cvdata_json]

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { runPipeline } from "./lib/pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , pdfArg, pageArg, cvDataArg] = process.argv;
if (!pdfArg) {
  console.error("Usage: node run_pipeline.mjs <pdf_path> [page_number] [cvdata_json]");
  process.exit(1);
}

const pdfPath = path.resolve(pdfArg);
// "all" = reproduire le template entier (toutes les pages du PDF).
const pageNumber = String(pageArg || "1").toLowerCase() === "all" ? "all" : (parseInt(pageArg || "1", 10) || 1);
const cvDataPath = cvDataArg ? path.resolve(cvDataArg) : undefined;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(__dirname, "out", runId);

try {
  const result = await runPipeline({
    pdfPath,
    pageNumber,
    cvDataPath,
    outDir,
    onProgress: (step, msg) => console.log(`[${step}] ${msg}`),
  });

  const finalPass = result.passes.at(-1);
  console.log("\n=== Terminé ===");
  console.log(`Dossier de sortie: ${result.outDir}`);
  console.log(`Cible:   ${result.targetPath}`);
  for (const p of result.passes) console.log(`${p.label}: ${p.pngPath}`);
  console.log(`Aperçu à ouvrir dans le navigateur: ${finalPass.htmlPath}`);
  console.log(`Tokens totaux: ${result.totalInputTokens} in / ${result.totalOutputTokens} out`);
  if (result.totalCacheReadTokens || result.totalCacheWriteTokens)
    console.log(`Cache: ${result.totalCacheWriteTokens} écrits / ${result.totalCacheReadTokens} lus`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
