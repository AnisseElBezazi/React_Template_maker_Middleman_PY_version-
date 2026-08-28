// Reçoit les requêtes de l'éditeur visuel : re-rendu d'un run, script
// d'incrustation, application des ajustements au JSX.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getRun } from "../runs/runs_service.mjs";
import { applyImageEdits, applyTextEdits, applyClassEdits } from "../jsx/apply_image_edits.mjs";
import { PIPELINE_ROOT } from "../shared/paths_shared.mjs";


/** Re-rend la dernière passe telle quelle (aucun appel Claude). Sert aux
 * runs générés avant l'ajout des repères `data-cvimg` : sans eux, l'éditeur
 * ne peut relier une image du rendu à sa balise dans le JSX. */
export function rerenderRun(req, res) {
  const state = getRun(req.params.id);
  if (!state || state.status !== "done") return res.status(404).send("Run introuvable ou pas terminé.");
  const finalPass = state.result.passes.at(-1);
  const runCvData = path.join(state.result.outDir, "generated_cvdata.json");
  const cvDataPath = fs.existsSync(runCvData) ? runCvData : path.join(PIPELINE_ROOT, "sample_cvdata.json");
  const r = spawnSync(
    "node",
    [path.join(PIPELINE_ROOT, "src", "rendering", "render.mjs"), finalPass.jsxPath, cvDataPath,
      finalPass.pngPath, String(state.result.width), String(state.result.height)],
    { encoding: "utf-8", cwd: PIPELINE_ROOT }
  );
  if (r.status !== 0) return res.status(500).send(`Rendu échoué: ${r.stderr || r.stdout}`);
  res.json({ ok: true });
}

export function editorOverlay(_req, res) {
  // Jamais de cache : ce script évolue souvent, et une version périmée
  // servie depuis le cache du navigateur donne un éditeur qui "ne marche
  // pas" alors que le correctif est bien sur le disque.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.type("application/javascript").sendFile(path.join(PIPELINE_ROOT, "src", "public", "editor_overlay.js"));
}

export function applyEdits(req, res) {
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
    const cvDataPath = fs.existsSync(runCvData) ? runCvData : path.join(PIPELINE_ROOT, "sample_cvdata.json");
    const r = spawnSync(
      "node",
      [path.join(PIPELINE_ROOT, "src", "rendering", "render.mjs"), finalPass.jsxPath, cvDataPath,
        finalPass.pngPath, String(state.result.width), String(state.result.height)],
      { encoding: "utf-8", cwd: PIPELINE_ROOT }
    );
    if (r.status !== 0) return res.status(500).send(`Rendu échoué: ${r.stderr || r.stdout}`);
    res.json({ ok: true, applied });
  } catch (err) {
    res.status(500).send(err.message);
  }
}
