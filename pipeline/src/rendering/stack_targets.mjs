// Empile les captures cibles d'un run multi-pages en une seule image, pour
// que le cadre de gauche de la page de résultat montre TOUTES les pages du
// template et pas seulement la première.
//
// L'empilement reproduit exactement celui du rendu : les pages générées sont
// posées dans un conteneur `flex flex-col gap-6`, soit 24 px de blanc entre
// deux pages (vérifié au pixel sur un rendu réel). Les deux cadres restent
// ainsi à la même échelle et se comparent directement à l'oeil, ce qui est
// tout l'intérêt de la vue côte à côte.

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const PAGE_GAP = 24; // Tailwind gap-6 sur le conteneur de pages

export function targetPages(outDir) {
  return fs.readdirSync(outDir)
    .filter((f) => /^target-\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
    .map((f) => path.join(outDir, f));
}

/** Chemin de la capture cible à afficher : l'empilement quand le run couvre
 * plusieurs pages, la page unique sinon. `null` si le run n'a aucune cible.
 * L'image empilée est construite une seule fois puis relue du disque. */
export function stackedTarget(outDir) {
  const pages = targetPages(outDir);
  if (pages.length <= 1) return pages[0] ?? null;

  const outPath = path.join(outDir, "target-stacked.png");
  if (fs.existsSync(outPath)) return outPath;

  const images = pages.map((p) => PNG.sync.read(fs.readFileSync(p)));
  const width = Math.max(...images.map((i) => i.width));
  const height = images.reduce((sum, i) => sum + i.height, 0) + PAGE_GAP * (images.length - 1);

  const out = new PNG({ width, height });
  out.data.fill(255); // gouttières blanches, comme dans le rendu
  let y = 0;
  for (const img of images) {
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, y);
    y += img.height + PAGE_GAP;
  }
  fs.writeFileSync(outPath, PNG.sync.write(out));
  return outPath;
}
