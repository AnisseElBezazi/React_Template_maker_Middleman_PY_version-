// Passe 5 (algorithmique, sans IA) -- dump TOUS les textes réellement rendus
// (pas seulement les titres en majuscules comme measure_dom_sizes.mjs) avec
// leur taille de police calculée ET la className de leur élément parent --
// sert à regrouper par composant partagé (ex: SectionBar réutilisé pour
// "Certifications", "Études", "Langues" -- une seule classe à corriger pour
// corriger les 3 d'un coup) plutôt que de corriger la police racine globale.
//
// Usage: node measure_dom_texts.mjs <html_file> <width> <height>
// Sortie JSON: [{ text, fontSizePx, className }, ...]

import path from "path";
import puppeteer from "puppeteer";

const [, , htmlFile, widthArg, heightArg] = process.argv;
const width = parseInt(widthArg || "1240", 10);
const height = parseInt(heightArg || "1754", 10);

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto("file://" + path.resolve(htmlFile), { waitUntil: "networkidle0" });
  const results = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text || text.length > 60) continue;
      const el = node.parentElement;
      if (!el || typeof el.className !== "string" || !el.className) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (!(size > 0)) continue;
      out.push({ text, fontSizePx: size, className: el.className });
    }
    return out;
  });
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
