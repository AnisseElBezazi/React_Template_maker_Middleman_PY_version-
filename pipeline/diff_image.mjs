// Génère une image de différence pixel-à-pixel entre la cible et le rendu
// actuel (pixelmatch) -- zones différentes surlignées en rouge vif sur fond
// grisé du reste, pour que Claude VOIE concrètement ses écarts au lieu de
// deviner en comparant deux images côte à côte.
//
// Usage CLI (test local) : node diff_image.mjs <target.png> <rendered.png> <out.png>

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function generateDiffImage(targetPath, renderedPath, outPath) {
  const img1 = PNG.sync.read(fs.readFileSync(targetPath));
  const img2 = PNG.sync.read(fs.readFileSync(renderedPath));
  if (img1.width !== img2.width || img1.height !== img2.height) {
    throw new Error(
      `Dimensions différentes entre cible (${img1.width}x${img1.height}) et rendu (${img2.width}x${img2.height}) -- diff impossible sans les recadrer d'abord.`
    );
  }
  const { width, height } = img1;
  const diff = new PNG({ width, height });
  const diffPixelCount = pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold: 0.1,
    diffColor: [255, 0, 0],
    alpha: 0.5,
  });
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  return { diffPixelCount, totalPixels: width * height, diffRatio: diffPixelCount / (width * height) };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const [, , targetPath, renderedPath, outPath] = process.argv;
  const result = generateDiffImage(targetPath, renderedPath, outPath);
  console.log(JSON.stringify(result));
}
