// Racines de fichiers de la pipeline et conversion d'un chemin absolu en URL
// publique. Regroupées ici parce que trois features s'en servent.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PIPELINE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const OUT_ROOT = path.join(PIPELINE_ROOT, "out");
export const UPLOADS_ROOT = path.join(PIPELINE_ROOT, "uploads");
export const TEMPLATES_ROOT = path.resolve(PIPELINE_ROOT, "..", "templates copy");
export const PUBLIC_ROOT = path.join(PIPELINE_ROOT, "src", "public");

export function ensureRoots() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

export function toPublicUrl(absPath) {
  return "/out/" + path.relative(OUT_ROOT, absPath).split(path.sep).join("/");
}
