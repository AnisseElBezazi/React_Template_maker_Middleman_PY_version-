// Passe 4 (algorithmique, sans IA) -- étape 2/2 : mesure la taille RÉELLEMENT
// rendue (getComputedStyle) des mêmes textes de titres statiques dans le
// composant généré, pour comparaison avec measure_dictionary.py.
//
// Usage: node measure_dom_sizes.mjs <html_file> <json_array_of_search_strings> <width> <height>
//
// width/height DOIVENT être le CANVAS_W/CANVAS_H réel (la taille de l'image
// cible) -- le composant se mesure lui-même via ResizeObserver et se
// réduit s'il est chargé dans un viewport plus étroit, ce qui fausserait
// toute comparaison avec le dictionnaire (échelle cible).

import path from "path";
import puppeteer from "puppeteer";

const [, , htmlFile, searchStringsJson, widthArg, heightArg] = process.argv;
const searchStrings = JSON.parse(searchStringsJson);
const width = parseInt(widthArg || "1240", 10);
const height = parseInt(heightArg || "1754", 10);

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto("file://" + path.resolve(htmlFile), { waitUntil: "networkidle0" });
  const results = await page.evaluate((strings) => {
    const out = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const upper = text.toUpperCase();
      if (strings.includes(upper) && !(upper in out)) {
        const el = node.parentElement;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size > 0) out[upper] = size;
      }
    }
    return out;
  }, searchStrings);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
