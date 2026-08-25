// Superpose une grille de repères (coordonnées X/Y tous les N pixels) sur
// une image -- pour que Claude puisse RAISONNER en coordonnées ("le bloc
// s'arrête à 300 au lieu de 450") plutôt qu'estimer à l'oeil. Réutilise
// Puppeteer (déjà une dépendance) pour composer image + grille en HTML/CSS
// et re-capturer, plutôt que d'ajouter une dépendance de dessin (canvas).
//
// Usage CLI (test local) : node grid_overlay.mjs <in.png> <out.png> <width> <height> [spacing]

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export async function addGridOverlay(imagePath, outPath, width, height, spacing = 50) {
  const imgB64 = fs.readFileSync(imagePath).toString("base64");
  const lines = [];
  for (let x = 0; x <= width; x += spacing) {
    lines.push(`<div style="position:absolute;left:${x}px;top:0;width:1px;height:${height}px;background:rgba(255,0,255,0.45)"></div>`);
    lines.push(`<div style="position:absolute;left:${x + 2}px;top:0;font:9px monospace;color:#d100d1;background:rgba(255,255,255,0.75);padding:0 1px;line-height:11px;">${x}</div>`);
  }
  for (let y = 0; y <= height; y += spacing) {
    lines.push(`<div style="position:absolute;left:0;top:${y}px;width:${width}px;height:1px;background:rgba(255,0,255,0.45)"></div>`);
    lines.push(`<div style="position:absolute;left:0;top:${y + 1}px;font:9px monospace;color:#d100d1;background:rgba(255,255,255,0.75);padding:0 1px;line-height:11px;">${y}</div>`);
  }
  const html = `<!doctype html><html><body style="margin:0;padding:0;width:${width}px;height:${height}px;position:relative;overflow:hidden;">
    <img src="data:image/png;base64,${imgB64}" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px;" />
    ${lines.join("\n")}
  </body></html>`;

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const [, , imagePath, outPath, widthArg, heightArg, spacingArg] = process.argv;
  await addGridOverlay(imagePath, outPath, parseInt(widthArg, 10), parseInt(heightArg, 10), spacingArg ? parseInt(spacingArg, 10) : 50);
  console.log("écrit:", outPath);
}
