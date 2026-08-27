// Compilation Tailwind, partagée entre l'aperçu et l'export vers la base.
//
// Les deux usages n'ont PAS les mêmes besoins :
// - l'aperçu vit dans une iframe isolée, il peut donc prendre `base` et
//   `components` (le reset Tailwind y est même souhaitable) ;
// - le CSS stocké en base est injecté DANS l'app, où un reset global
//   casserait le reste de la page : utilities seules, et scopées.
// D'où les paramètres plutôt qu'une seconde implémentation.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const PIPELINE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function compileTailwind({ contentGlobs, inputCss, configPath = null, minify = true }) {
  // Chemin UNIQUE par compilation : plusieurs rendus peuvent tourner en
  // parallèle (traitement de templates par lots). Avec un fichier partagé,
  // l'un lisait le CSS pendant que l'autre le réécrivait -- classes
  // manquantes, images à leur taille naturelle, mises en page cassées de
  // façon intermittente et très difficile à relier à sa cause.
  const outCss = path.join(PIPELINE_ROOT, "out", `.tailwind-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.css`);
  fs.mkdirSync(path.dirname(outCss), { recursive: true });

  const args = ["-i", inputCss, "-o", outCss, "--content", contentGlobs];
  if (configPath) args.push("-c", configPath);
  if (minify) args.push("--minify");

  const result = spawnSync(path.join(PIPELINE_ROOT, "node_modules", ".bin", "tailwindcss"), args, {
    encoding: "utf-8",
    cwd: PIPELINE_ROOT,
  });

  if (result.status !== 0) {
    try { fs.unlinkSync(outCss); } catch { /* rien à nettoyer */ }
    return { css: "", error: result.stderr || result.stdout || "tailwindcss a échoué" };
  }
  const css = fs.readFileSync(outCss, "utf-8");
  try { fs.unlinkSync(outCss); } catch { /* fichier temporaire, sans importance */ }
  return { css, error: null };
}
