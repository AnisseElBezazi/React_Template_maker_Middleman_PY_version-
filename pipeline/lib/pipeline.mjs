// Coeur de la pipeline Design-to-Code, réutilisable par le CLI
// (run_pipeline.mjs) et par le serveur web (server.mjs).
//
// Étape 1 (extraction, réutilise converter.py) -> screenshot cible + dictionnaire HTML
// Étape 2 (3 passes Claude avec feedback visuel via render.mjs/Puppeteer)
// Étape 3 (retourne le .jsx final + toutes les captures intermédiaires)

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateSampleCvData } from "../generate_sample_from_extra_config.mjs";
import { generateDiffImage } from "../diff_image.mjs";
import { addGridOverlay } from "../grid_overlay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(PIPELINE_ROOT, "..");
const TEMPLATES_ROOT = path.join(PROJECT_ROOT, "templates copy");
const MODEL = "claude-sonnet-5";

function pngDimensions(pngPath) {
  const buf = fs.readFileSync(pngPath);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readPromptTemplate(name) {
  return fs.readFileSync(path.join(PIPELINE_ROOT, "prompts", name), "utf-8");
}

function extractCode(text) {
  const fenced = text.match(/```(?:jsx|javascript|js)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** Échoue vite avec un message clair si la réponse extraite n'a manifestement
 * pas de JSX exploitable (ex: max_tokens entièrement consommé par la
 * réflexion étendue, réponse vide) -- plutôt que de laisser passer un
 * fichier vide/tronqué jusqu'au rendu esbuild, où l'erreur produite
 * ("No matching export... for import default") ne dit rien sur la vraie
 * cause. */
function assertValidJsx(code, step) {
  if (!code || !/export\s+default/.test(code)) {
    throw new Error(
      `Passe ${step} : réponse de Claude sans JSX exploitable (probablement max_tokens entièrement consommé par la réflexion, sans place pour la réponse finale -- réessaie, ou augmente maxTokens dans callClaude).`
    );
  }
}

function readTemplateFile(rel) {
  return fs.readFileSync(path.join(TEMPLATES_ROOT, rel), "utf-8");
}

const IMAGE_IMPORT_RE = /@\/images\/cv-templates\/([a-zA-Z0-9_-]+)\/extracted-(\d+)\.(png|jpe?g)/g;

/** Copie les vraies images extraites du PDF vers l'emplacement exact que le
 * JSX généré référence (@/images/cv-templates/<slug>/extracted-N.ext) --
 * le nom du template (<slug>) n'est décidé par l'IA qu'à la génération,
 * donc on ne peut placer les fichiers qu'après coup, en relisant le code. */
function placeExtractedImages(jsxCode, outDir) {
  for (const match of jsxCode.matchAll(IMAGE_IMPORT_RE)) {
    const [, slug, index, ext] = match;
    const src = path.join(outDir, `extracted-${index}.png`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(TEMPLATES_ROOT, "images", "cv-templates", slug, `extracted-${index}.${ext}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** Un élément graphique du PDF sans équivalent bitmap (logo/ruban/forme
 * dessinés en vectoriel, que pdfimages ne peut pas extraire) : l'IA nous
 * donne sa zone en pixels, on la découpe.
 *
 * On découpe depuis le CALQUE DÉCOR (fond sans texte) et non depuis la
 * capture cible dès qu'il est disponible : les deux ont exactement les
 * mêmes dimensions et le même repère (voir extract_background.py), mais le
 * calque ne contient AUCUN texte -- donc plus aucun risque de figer du
 * Jinja brut ({{ ... }}) dans une découpe, ce qui interdisait jusqu'ici de
 * découper autre chose qu'un petit élément isolé. */
function cropExtraImages(rawResponseText, targetPath, outDir, pythonBin) {
  const match = rawResponseText.match(/EXTRA_IMAGES:\s*(\[[\s\S]*?\])/);
  if (!match) return;
  let entries;
  try {
    entries = JSON.parse(match[1]);
  } catch {
    return;
  }
  const bgPath = path.join(outDir, "background-layer.png");
  const sourcePath = fs.existsSync(bgPath) ? bgPath : targetPath;
  for (const { index, x, y, width: w, height: h } of entries) {
    if (index == null || x == null || y == null || !w || !h) continue;
    const outPath = path.join(outDir, `extracted-${index}.png`);
    const result = spawnSync(pythonBin, [
      path.join(PIPELINE_ROOT, "crop_image.py"), sourcePath, String(x), String(y), String(w), String(h), outPath,
    ], { encoding: "utf-8" });
    if (result.status !== 0) continue;
  }
}

export async function runPipeline({
  pdfPath,
  pageNumber = 1,
  cvDataPath = path.join(PIPELINE_ROOT, "sample_cvdata.json"),
  extraConfigPath,
  onStream = () => {},
  outDir,
  onProgress = () => {},
}) {
  if (!fs.existsSync(pdfPath))
    throw new Error(`PDF introuvable: ${pdfPath}`);
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY manquante. Crée pipeline/.env avec ANTHROPIC_API_KEY=sk-...");

  fs.mkdirSync(outDir, { recursive: true });

  // Si un extra_config (schéma CvParserConfig du client/template réel) est
  // fourni, il remplace le schéma générique sample_cvdata.json : chaque
  // template peut avoir des champs différents (voir CvParserConfig côté
  // backend), donc un schéma unique pour tous ne colle pas toujours --
  // certains champs manquent dans l'aperçu et Claude peut inventer des noms
  // de champs qui n'existent pas pour CE client précis.
  let usingCustomSchema = false;
  if (extraConfigPath) {
    const extraConfig = JSON.parse(fs.readFileSync(extraConfigPath, "utf-8"));
    const generatedCvData = generateSampleCvData(extraConfig);
    cvDataPath = path.join(outDir, "generated_cvdata.json");
    fs.writeFileSync(cvDataPath, JSON.stringify(generatedCvData, null, 2));
    usingCustomSchema = true;
  }

  // --- Étape 1 : extraction (screenshot cible + dictionnaire de style, une seule page) ---
  onProgress("extract", `Génération du screenshot cible et du dictionnaire HTML (page ${pageNumber})...`);
  const venvPython = path.join(PROJECT_ROOT, "venv", "bin", "python3");
  const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";
  const extractResult = spawnSync(
    pythonBin,
    [path.join(PIPELINE_ROOT, "extract.py"), pdfPath, outDir, String(pageNumber)],
    { encoding: "utf-8" }
  );
  if (extractResult.status !== 0)
    throw new Error(`Extraction échouée: ${extractResult.stderr}`);

  const extractLines = extractResult.stdout.trim().split("\n");
  const dictionaryPath = extractLines.find((l) => l.startsWith("DICTIONARY:")).slice("DICTIONARY:".length);
  const jinjaTagsPath = extractLines.find((l) => l.startsWith("JINJA_TAGS:"))?.slice("JINJA_TAGS:".length);
  const extractedImagesPath = extractLines.find((l) => l.startsWith("EXTRACTED_IMAGES:"))?.slice("EXTRACTED_IMAGES:".length);
  const targetPath = extractLines.find((l) => l.startsWith("TARGET:"))?.slice("TARGET:".length);
  if (!targetPath)
    throw new Error("Aucune image cible produite par extract.py.");

  const { width, height } = pngDimensions(targetPath);
  const jinjaTags = jinjaTagsPath ? JSON.parse(fs.readFileSync(jinjaTagsPath, "utf-8")) : [];
  const extractedImages = extractedImagesPath ? JSON.parse(fs.readFileSync(extractedImagesPath, "utf-8")) : [];
  onProgress(
    "extract",
    `Cible: ${path.basename(targetPath)} (${width}x${height}px), ${jinjaTags.length} tag(s) Jinja, ${extractedImages.length} image(s) extraite(s).`
  );

  // Calque décor : le fond de page SANS TEXTE que pdftohtml -c produit déjà
  // (formes vectorielles, dégradés, photos, logos composités). C'est la
  // seule référence fiable pour une décoration complexe -- la redessiner en
  // CSS échoue dès qu'elle sort du rectangle simple, et découper la capture
  // cible y figerait le texte Jinja brut. Normalisé à la taille exacte de la
  // cible pour que les coordonnées soient interchangeables.
  const backgroundPath = path.join(outDir, "background-layer.png");
  const bgResult = spawnSync(
    pythonBin,
    [path.join(PIPELINE_ROOT, "extract_background.py"), dictionaryPath, backgroundPath, String(width), String(height)],
    { encoding: "utf-8" }
  );
  const hasBackground = bgResult.status === 0 && fs.existsSync(backgroundPath);
  onProgress("extract", hasBackground
    ? "Calque décor (fond sans texte) extrait."
    : "Calque décor indisponible -- les découpes retomberont sur la capture cible.");

  // Dictionnaire compact (texte+taille+couleur, sans le HTML/CSS autour) --
  // même signal utile pour la passe 2, beaucoup moins de tokens que le HTML
  // brut (typiquement -99%, voir compact_dictionary.py).
  const compactDictResult = spawnSync(pythonBin, [path.join(PIPELINE_ROOT, "compact_dictionary.py"), dictionaryPath], { encoding: "utf-8" });
  const dictionaryCompact = compactDictResult.status === 0 && compactDictResult.stdout.trim()
    ? compactDictResult.stdout
    : fs.readFileSync(dictionaryPath, "utf-8").slice(0, 40000); // repli si le compactage échoue
  const jinjaTagsText = jinjaTags.length ? jinjaTags.join("\n") : "(aucun tag Jinja détecté sur cette page)";

  // On plafonne à 8 images (les plus grandes -- probablement les plus
  // visuellement significatives, fonds/logos plutôt que puces décoratives)
  // pour ne pas exploser le coût de la passe 1 en tokens de vision.
  const topImages = [...extractedImages].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8);
  const extractedImagesText = topImages.length
    ? topImages.map((img, i) => `extracted-${extractedImages.indexOf(img) + 1} : ${img.width}x${img.height}px`).join("\n")
    : "(aucune image intégrée trouvée sur cette page)";
  const extractedImageBlocks = topImages.flatMap((img) => {
    const idx = extractedImages.indexOf(img) + 1;
    return [
      { type: "text", text: `Image extraite extracted-${idx} (${img.width}x${img.height}px) :` },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(img.path).toString("base64") } },
    ];
  });

  const goldenReference = [
    "--- MOTEUR UNIVERSEL (ne pas réécrire -- importer tel quel via les mêmes chemins @/components/CvSmart/templates/engine/...) ---",
    "// engine/paginationEngine.js",
    readTemplateFile("engine/paginationEngine.js"),
    "// engine/usePaginatedGroups.js",
    readTemplateFile("engine/usePaginatedGroups.js"),
    "// engine/PaginatedEntryPages.jsx",
    readTemplateFile("engine/PaginatedEntryPages.jsx"),
    "// engine/entryFragments.jsx",
    readTemplateFile("engine/entryFragments.jsx"),
    "--- EXEMPLE COMPLET DÉJÀ INTÉGRÉ EN PRODUCTION (template Visian -- sert de patron de conventions, NE PAS le reproduire pour un autre template) ---",
    "// VisianTemplateHtml.jsx",
    readTemplateFile("VisianTemplateHtml.jsx"),
    usingCustomSchema
      ? "--- SCHÉMA cvData -- SPÉCIFIQUE à ce client/template précis (dérivé de son extra_config réel, pas un schéma générique) -- utiliser EXACTEMENT ces noms de champs, ne pas réutiliser ceux d'un autre template CV Smart ---"
      : "--- SCHÉMA cvData (générique, aucun extra_config fourni pour ce test -- utiliser EXACTEMENT ces noms de champs) ---",
    fs.readFileSync(cvDataPath, "utf-8"),
  ].join("\n\n");

  // Bloc image partagé tel quel entre la passe 1 et la passe 2, en tout
  // premier dans les deux messages -- le cache Anthropic ne s'accroche que
  // sur un préfixe identique, donc rien ne doit précéder ce bloc dans
  // aucune des deux passes pour qu'il soit effectivement réutilisé.
  const targetImageB64 = fs.readFileSync(targetPath).toString("base64");
  const targetImageBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: targetImageB64 },
    cache_control: { type: "ephemeral" },
  };

  const anthropic = new Anthropic();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;

  async function callClaude(step, content, maxTokens = 64000) {
    onProgress(step, "Appel à Claude...");
    // En non-streaming, la réflexion étendue (activée par défaut sur Sonnet 5,
    // pas de budget_tokens séparable) peut consommer tout le max_tokens sans
    // laisser de place au JSX final -- déjà vu produire un fichier vide malgré
    // "usage.output_tokens" au plafond. Le streaming évite aussi les timeouts
    // HTTP sur un aussi gros max_tokens (recommandation officielle du SDK).
    const stream = anthropic.messages.stream({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] });
    let thinkingBuf = "";
    let textBuf = "";
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "thinking_delta") {
        thinkingBuf += event.delta.thinking;
        onStream(step, "thinking", thinkingBuf.slice(-4000));
      } else if (event.delta.type === "text_delta") {
        textBuf += event.delta.text;
        onStream(step, "text", textBuf.slice(-4000));
      }
    }
    const msg = await stream.finalMessage();
    totalInputTokens += msg.usage.input_tokens;
    totalOutputTokens += msg.usage.output_tokens;
    const cacheRead = msg.usage.cache_read_input_tokens || 0;
    const cacheWrite = msg.usage.cache_creation_input_tokens || 0;
    totalCacheReadTokens += cacheRead;
    totalCacheWriteTokens += cacheWrite;
    onProgress(
      step,
      `Tokens: +${msg.usage.input_tokens} in / +${msg.usage.output_tokens} out` +
        (cacheRead || cacheWrite ? ` (cache: +${cacheWrite} écrits, +${cacheRead} lus)` : "") +
        ` (cumulé: ${totalInputTokens} in / ${totalOutputTokens} out)`
    );
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  function render(jsxPath, pngOutPath) {
    const result = spawnSync(
      "node",
      [path.join(PIPELINE_ROOT, "render.mjs"), jsxPath, cvDataPath, pngOutPath, String(width), String(height)],
      { encoding: "utf-8", cwd: PIPELINE_ROOT }
    );
    if (result.status !== 0)
      throw new Error(`Rendu de ${jsxPath} échoué: ${result.stderr || result.stdout}`);
    if (result.stderr && result.stderr.includes("RENDER_ERRORS:"))
      onProgress("render", `Avertissement -- erreurs JS dans le composant rendu: ${result.stderr.trim()}`);
  }

  const passes = [];

  // --- Passe 1 : premier jet (structure + layout) ---
  // Le Golden Reference (moteur + VisianTemplateHtml.jsx + schéma, ~15-20k
  // tokens) est identique à chaque appel, sur CE run comme sur tout autre
  // template -- isolé dans son propre bloc caché plutôt que noyé dans le
  // texte du prompt, pour que les appels suivants (page suivante, autre
  // template, dans la fenêtre de cache) le relisent à prix cassé.
  const [pass1Before, pass1After] = readPromptTemplate("pass1.md").split("{{GOLDEN_REFERENCE}}").map((part) =>
    part
      .replace(/\{\{CANVAS_SIZE\}\}/g, `${width} x ${height}`)
      .replace(/\{\{JINJA_TAGS\}\}/g, jinjaTagsText)
      .replace(/\{\{EXTRACTED_IMAGES\}\}/g, extractedImagesText)
  );
  const backgroundImageBlocks = hasBackground
    ? [
        { type: "text", text: `CALQUE DÉCOR (même repère que l'image cible, ${width} x ${height}) -- toutes les formes/photos/logos de la page, SANS AUCUN TEXTE. C'est ta source pour toute découpe EXTRA_IMAGES :` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(backgroundPath).toString("base64") } },
      ]
    : [];
  const jsx1Raw = await callClaude("pass1", [
    targetImageBlock,
    { type: "text", text: pass1Before },
    { type: "text", text: goldenReference, cache_control: { type: "ephemeral" } },
    { type: "text", text: pass1After },
    ...backgroundImageBlocks,
    ...extractedImageBlocks,
  ]);
  const jsx1 = extractCode(jsx1Raw);
  assertValidJsx(jsx1, "1");
  const jsx1Path = path.join(outDir, "attempt1.jsx");
  fs.writeFileSync(jsx1Path, jsx1);
  cropExtraImages(jsx1Raw, targetPath, outDir, pythonBin);
  placeExtractedImages(jsx1, outDir);
  const png1Path = path.join(outDir, "attempt1.png");
  onProgress("pass1", "Rendu de la tentative 1...");
  render(jsx1Path, png1Path);
  passes.push({ name: "pass1", label: "Passe 1 -- premier jet", jsxPath: jsx1Path, pngPath: png1Path, htmlPath: png1Path.replace(/\.png$/i, ".html") });
  onProgress("pass1", "OK");

  // --- Passe 2 : diff visuel + auto-correction ---
  // Grille de coordonnées + image de différence pixelmatch (voir
  // diff_image.mjs/grid_overlay.mjs) : sans ça, Claude compare deux images
  // "à l'oeil" et sous-estime régulièrement des écarts de taille/position
  // pourtant réels. Remplace le simple envoi cible+rendu par 3 images
  // gardées, chacune avec repères. Ça casse le partage de cache avec la
  // passe 1 (image cible différente, quadrillée) -- accepté pour la
  // précision, la passe 1 garde son bloc caché tel quel.
  onProgress("pass2", "Génération de la grille de repères et de l'image de différence...");
  let pass2ImageBlocks;
  try {
    const targetGridPath = path.join(outDir, "target-grid.png");
    const render1GridPath = path.join(outDir, "attempt1-grid.png");
    const diffPath = path.join(outDir, "diff1.png");
    const diffGridPath = path.join(outDir, "diff1-grid.png");
    await addGridOverlay(targetPath, targetGridPath, width, height);
    await addGridOverlay(png1Path, render1GridPath, width, height);
    const diffStats = generateDiffImage(targetPath, png1Path, diffPath);
    await addGridOverlay(diffPath, diffGridPath, width, height);
    onProgress("pass2", `Diff pixelmatch : ${(diffStats.diffRatio * 100).toFixed(1)}% de pixels différents.`);
    pass2ImageBlocks = [
      { type: "text", text: "Image 1 (CIBLE, grille de repères tous les 50px) :" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(targetGridPath).toString("base64") } },
      { type: "text", text: "Image 2 (TON RENDU ACTUEL, même grille) :" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(render1GridPath).toString("base64") } },
      { type: "text", text: "Image 3 (DIFFÉRENCE pixelmatch, rouge = écart, même grille) :" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(diffGridPath).toString("base64") } },
    ];
  } catch (err) {
    onProgress("pass2", `Grille/diff indisponible (${err.message}) -- repli sur l'envoi simple des 2 images.`);
    pass2ImageBlocks = [
      targetImageBlock,
      { type: "text", text: "^ Image 1 (CIBLE)." },
      { type: "text", text: "Image 2 (TON RENDU ACTUEL) :" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(png1Path).toString("base64") } },
    ];
  }
  const pass2Prompt = readPromptTemplate("pass2.md")
    .replace("{{JSX}}", jsx1)
    .replace("{{DICTIONARY}}", dictionaryCompact)
    .replace(/\{\{CANVAS_SIZE\}\}/g, `${width} x ${height}`);
  const jsx2Raw = await callClaude("pass2", [...pass2ImageBlocks, { type: "text", text: pass2Prompt }]);
  const jsx2 = extractCode(jsx2Raw);
  assertValidJsx(jsx2, "2");
  const jsx2Path = path.join(outDir, "attempt2.jsx");
  fs.writeFileSync(jsx2Path, jsx2);
  cropExtraImages(jsx2Raw, targetPath, outDir, pythonBin);
  placeExtractedImages(jsx2, outDir);
  const png2Path = path.join(outDir, "attempt2.png");
  onProgress("pass2", "Rendu de la tentative 2...");
  render(jsx2Path, png2Path);
  passes.push({ name: "pass2", label: "Passe 2 -- diff visuel", jsxPath: jsx2Path, pngPath: png2Path, htmlPath: png2Path.replace(/\.png$/i, ".html") });
  onProgress("pass2", "OK");

  // --- Passe 3 : audit sécurité / câblage ---
  const pass3Prompt = readPromptTemplate("pass3.md").replace("{{JSX}}", jsx2);
  const jsx3Raw = await callClaude("pass3", [{ type: "text", text: pass3Prompt }]);
  const jsx3 = extractCode(jsx3Raw);
  assertValidJsx(jsx3, "3");
  const jsx3Path = path.join(outDir, "attempt3.jsx");
  fs.writeFileSync(jsx3Path, jsx3);
  placeExtractedImages(jsx3, outDir);
  const png3Path = path.join(outDir, "attempt3.png");
  onProgress("pass3", "Rendu de la tentative 3...");
  render(jsx3Path, png3Path);
  passes.push({ name: "pass3", label: "Passe 3 -- audit", jsxPath: jsx3Path, pngPath: png3Path, htmlPath: png3Path.replace(/\.png$/i, ".html") });
  onProgress("pass3", "OK");

  // --- Passe 4 : correction d'échelle ALGORITHMIQUE (aucun appel Claude) ---
  // La passe 2 demande à l'IA de reprendre les tailles exactes du
  // dictionnaire, mais elle ne le fait pas assez rigoureusement pour la
  // taille de police RACINE (dont tout le reste dépend en em) -- ici on la
  // mesure et on la corrige par calcul, pas par supposition.
  onProgress("scale-fix", "Mesure des tailles réelles (dictionnaire vs. rendu)...");
  let finalPath = jsx3Path;
  let finalPngPath = png3Path;
  let scaleNote = "aucune correction nécessaire";
  try {
    const dictResult = spawnSync(pythonBin, [path.join(PIPELINE_ROOT, "measure_dictionary.py"), dictionaryPath], { encoding: "utf-8" });
    const dictSizes = dictResult.status === 0 ? JSON.parse(dictResult.stdout || "{}") : {};
    const headings = Object.keys(dictSizes);

    if (headings.length >= 2) {
      const domResult = spawnSync(
        "node",
        [path.join(PIPELINE_ROOT, "measure_dom_sizes.mjs"), png3Path.replace(/\.png$/i, ".html"), JSON.stringify(headings), String(width), String(height)],
        { encoding: "utf-8", cwd: PIPELINE_ROOT }
      );
      const domSizes = domResult.status === 0 ? JSON.parse(domResult.stdout || "{}") : {};

      const ratios = headings
        .filter((h) => domSizes[h] > 0)
        .map((h) => dictSizes[h] / domSizes[h])
        .sort((a, b) => a - b);

      if (ratios.length >= 2) {
        const median = ratios[Math.floor(ratios.length / 2)];
        onProgress("scale-fix", `Ratio mesuré: ${median.toFixed(3)} (sur ${ratios.length} titres comparés)`);

        if (Math.abs(median - 1) > 0.08) {
          const rootFontRe = /(fontSize:\s*containerWidth\s*\?\s*`\$\{\(containerWidth\s*\*\s*\()([\d.]+)(\s*\/\s*CANVAS_W\)\)[^}]*\}px`\s*:\s*')([\d.]+)(px')/;
          const match = jsx3.match(rootFontRe);
          if (match) {
            const oldValue = parseFloat(match[2]);
            const newValue = (oldValue * median).toFixed(2);
            const jsx4 = jsx3.replace(rootFontRe, (m, pre1, _old1, mid, _old2, suf) => `${pre1}${newValue}${mid}${newValue}${suf}`);
            finalPath = path.join(outDir, "final.jsx");
            fs.writeFileSync(finalPath, jsx4);
            placeExtractedImages(jsx4, outDir);
            finalPngPath = path.join(outDir, "final.png");
            render(finalPath, finalPngPath);
            scaleNote = `police racine corrigée de ${oldValue} à ${newValue} (x${median.toFixed(3)})`;
          } else {
            scaleNote = `écart de ${median.toFixed(3)} détecté mais le motif fontSize attendu n'a pas été trouvé dans le JSX -- pas de correction appliquée`;
          }
        }
      } else {
        scaleNote = "pas assez de titres correspondants trouvés pour mesurer un ratio fiable";
      }
    } else {
      scaleNote = "pas assez de titres statiques détectés dans le dictionnaire";
    }
  } catch (err) {
    scaleNote = `mesure échouée (${err.message}) -- pas de correction appliquée`;
  }
  onProgress("scale-fix", scaleNote);
  passes.push({ name: "final", label: "Passe 4 -- correction d'échelle", jsxPath: finalPath, pngPath: finalPngPath, htmlPath: finalPngPath.replace(/\.png$/i, ".html") });

  // --- Passe 5 : correction de tailles PAR ÉLÉMENT, ALGORITHMIQUE (aucun appel Claude) ---
  // La passe 4 ne corrige qu'UN SEUL facteur d'échelle global (médiane sur
  // les titres trouvés) -- elle rate les écarts par élément : (a) une image
  // dont l'em ne correspond pas à sa taille native réelle (vérité terrain :
  // les images extraites sont capturées à la même échelle/DPI que la cible,
  // donc leurs dimensions natives en pixels = la bonne taille d'affichage),
  // et (b) un composant de titre partagé (ex: un seul <SectionBar> réutilisé
  // pour "Certifications"/"Études"/"Langues") dont la classe text-[Xem] est
  // fausse pour TOUTES ses occurrences à la fois.
  onProgress("size-fix", "Mesure des tailles par élément (images + libellés statiques)...");
  let sizeFixNote = "aucune correction nécessaire";
  try {
    let jsxCurrent = fs.readFileSync(finalPath, "utf-8");
    let changed = false;
    const notes = [];

    const rootFontMatch = jsxCurrent.match(/fontSize:\s*containerWidth\s*\?\s*`\$\{\(containerWidth\s*\*\s*\(([\d.]+)\s*\/\s*CANVAS_W\)\)/);
    const rootFontPx = rootFontMatch ? parseFloat(rootFontMatch[1]) : null;

    // --- Composant A : tailles d'images (dimensions natives réelles = vérité terrain) ---
    // ATTENTION : ça n'est vrai QUE pour les images issues du mécanisme
    // EXTRA_IMAGES (crop_image.py découpe directement la capture cible, à
    // la même échelle/DPI qu'elle -- donc 1:1 garanti). Les images du lot
    // initial (pdfimages, indices 1..N = extractedImages.length) sont les
    // ressources brutes embarquées dans le PDF, qui peuvent être encodées à
    // une résolution bien plus haute que leur taille d'affichage réelle sur
    // la page (matrice de placement du PDF) -- leur taille native n'a AUCUN
    // rapport garanti avec la bonne taille d'affichage, il ne faut donc pas
    // les toucher ici (vérifié empiriquement : un logo pdfimages de
    // 2425x899px natif s'affichait correctement en h-[4em] ~ 80px).
    if (rootFontPx) {
      const importRe = /import\s+(\w+)\s+from\s+['"]@\/images\/cv-templates\/[a-zA-Z0-9_-]+\/extracted-(\d+)\.(?:png|jpe?g)['"]/g;
      for (const [, varName, index] of jsxCurrent.matchAll(importRe)) {
        if (parseInt(index, 10) <= extractedImages.length) continue; // lot initial pdfimages -- pas fiable
        const imgPath = path.join(outDir, `extracted-${index}.png`);
        if (!fs.existsSync(imgPath)) continue;
        const { width: nativeW, height: nativeH } = pngDimensions(imgPath);
        const imgTagRe = new RegExp(`<img\\s[^>]*src=\\{${varName}\\}[^>]*className="([^"]*)"[^>]*/?>`, "g");
        jsxCurrent = jsxCurrent.replace(imgTagRe, (fullTag, classStr) => {
          if (/rotate-\[/.test(classStr)) return fullTag; // image tournée -- non gérée ici (voir règle passe 1)
          let localChanged = false;
          const newClassStr = classStr.replace(/(^|\s)(h|w)-\[([\d.]+)em\]/g, (mm, sp, dim, oldEmStr) => {
            const nativePx = dim === "h" ? nativeH : nativeW;
            const correctEm = nativePx / rootFontPx;
            const oldEm = parseFloat(oldEmStr);
            if (Math.abs(correctEm - oldEm) / correctEm > 0.2) {
              notes.push(`image ${varName}: ${dim}-[${oldEm}em] -> ${dim}-[${correctEm.toFixed(2)}em] (natif ${nativePx}px)`);
              localChanged = true;
              return `${sp}${dim}-[${correctEm.toFixed(2)}em]`;
            }
            return mm;
          });
          if (!localChanged) return fullTag;
          changed = true;
          return fullTag.replace(classStr, newClassStr);
        });
      }
    }

    // --- Composant B : tailles de libellés statiques, regroupées par classe partagée ---
    const dictResult2 = spawnSync(pythonBin, [path.join(PIPELINE_ROOT, "compact_dictionary.py"), dictionaryPath], { encoding: "utf-8" });
    const dictEntries = [];
    for (const line of (dictResult2.stdout || "").split("\n")) {
      const m = line.match(/^[\d.]+,[\d.]+\|([\d.]+)px\|[^|]*\|(.*)$/);
      if (m) dictEntries.push({ sizePx: parseFloat(m[1]), text: m[2].trim() });
    }
    const normalize = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const byText = {};
    for (const { sizePx, text } of dictEntries) {
      const key = normalize(text);
      if (!key || key.startsWith("{%") || key.startsWith("{{")) continue;
      (byText[key] ||= []).push(sizePx);
    }
    const dictSizeMap = {};
    for (const [key, sizes] of Object.entries(byText)) {
      const sorted = [...sizes].sort((a, b) => a - b);
      dictSizeMap[key] = sorted[Math.floor(sorted.length / 2)];
    }

    const currentHtmlPath = finalPngPath.replace(/\.png$/i, ".html");
    const domResult2 = spawnSync(
      "node",
      [path.join(PIPELINE_ROOT, "measure_dom_texts.mjs"), currentHtmlPath, String(width), String(height)],
      { encoding: "utf-8", cwd: PIPELINE_ROOT }
    );
    const domTexts = domResult2.status === 0 ? JSON.parse(domResult2.stdout || "[]") : [];

    const groups = {};
    for (const { text, fontSizePx, className } of domTexts) {
      const targetSize = dictSizeMap[normalize(text)];
      if (targetSize == null || !(fontSizePx > 0)) continue;
      (groups[className] ||= []).push(targetSize / fontSizePx);
    }
    for (const [className, ratios] of Object.entries(groups)) {
      if (!/text-\[[\d.]+em\]/.test(className)) continue;
      const sorted = [...ratios].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (Math.abs(median - 1) <= 0.1) continue;
      const emMatch = className.match(/text-\[([\d.]+)em\]/);
      const oldEm = parseFloat(emMatch[1]);
      const newEm = (oldEm * median).toFixed(2);
      const newClassName = className.replace(/text-\[[\d.]+em\]/, `text-[${newEm}em]`);
      if (jsxCurrent.includes(className)) {
        jsxCurrent = jsxCurrent.split(className).join(newClassName);
        notes.push(`libellé (${ratios.length}x) "${className.slice(0, 40)}...": text-[${oldEm}em] -> text-[${newEm}em]`);
        changed = true;
      }
    }

    if (changed) {
      const jsx5Path = path.join(outDir, "final.jsx");
      fs.writeFileSync(jsx5Path, jsxCurrent);
      placeExtractedImages(jsxCurrent, outDir);
      const png5Path = path.join(outDir, "final.png");
      render(jsx5Path, png5Path);
      finalPath = jsx5Path;
      finalPngPath = png5Path;
      sizeFixNote = notes.join(" | ");
      passes[passes.length - 1] = { name: "final", label: "Passe 4+5 -- corrections d'échelle et de tailles", jsxPath: finalPath, pngPath: finalPngPath, htmlPath: finalPngPath.replace(/\.png$/i, ".html") };
    }
  } catch (err) {
    sizeFixNote = `mesure échouée (${err.message}) -- pas de correction appliquée`;
  }
  onProgress("size-fix", sizeFixNote);
  onProgress("done", "Terminé.");

  return {
    outDir, targetPath, dictionaryPath, width, height, passes,
    totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens,
  };
}
