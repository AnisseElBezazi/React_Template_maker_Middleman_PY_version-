// Coeur de la pipeline Design-to-Code, réutilisable par le CLI
// (run_pipeline.mjs) et par le serveur web (server.mjs).
//
// Étape 1 (extraction, réutilise converter.py) -> screenshot cible + dictionnaire HTML
// Étape 2 (3 passes Claude avec feedback visuel via render.mjs/Puppeteer)
// Étape 3 (retourne le .jsx final + toutes les captures intermédiaires)

import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateSampleCvData } from "../generate_sample_from_extra_config.mjs";
import { generateDiffImage } from "../diff_image.mjs";
import { addGridOverlay } from "../grid_overlay.mjs";
import { auditJsx } from "../audit_jsx.mjs";
import { addTextSafety } from "../add_text_safety.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(PIPELINE_ROOT, "..");
dotenv.config();
dotenv.config({ path: path.join(PIPELINE_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
const TEMPLATES_ROOT = path.join(PROJECT_ROOT, "templates copy");
// Kimi K3 (Moonshot) expose une API compatible OpenAI : on bascule de client
// selon le modèle choisi, sans toucher au reste de la pipeline.
// Kimi K3 est accessible chez plusieurs fournisseurs, avec des identifiants
// de modèle ET des endpoints différents -- une clé de l'un ne fonctionne pas
// chez l'autre (erreur 401). Les deux configurations connues :
//   Moonshot (platform.kimi.ai) : "kimi-k3"            + api.moonshot.ai/v1
//   Baseten                      : "moonshotai/Kimi-K3" + inference.baseten.co/v1
const MODEL = "kimi-k3";
const IS_MOONSHOT = MODEL.toLowerCase().includes("kimi");
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
// Tarifs par million de tokens, pour estimer le coût réel : les figer sur un
// seul modèle sous-estimait la facture dès qu'on en changeait.
const PRICING = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-fable-5": { in: 10, out: 50 },
  "kimi-k3": { in: 3, out: 15 },
  "moonshotai/Kimi-K3": { in: 3, out: 15 },
};
const RATE = PRICING[MODEL] ?? PRICING["claude-sonnet-5"];

function pngDimensions(pngPath) {
  const buf = fs.readFileSync(pngPath);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readPromptTemplate(name) {
  return fs.readFileSync(path.join(PIPELINE_ROOT, "prompts", name), "utf-8");
}

function extractCode(text) {
  const fenced = text.match(/```(?:jsx|javascript|js)?\n([\s\S]*?)```/);
  let code = (fenced ? fenced[1] : text).trim();
  // Les lignes de déclarationattachées au JSX (EXTRA_IMAGES, ASSETS) sont lues
  // séparément depuis la réponse brute ; laissées dans le fichier, elles le
  // rendent invalide. `EXTRA_IMAGES:[...]` passait par chance (JS y voit une
  // étiquette suivie d'un tableau), mais `ASSETS:{"clé": 1}` est une erreur
  // de syntaxe franche.
  code = code.replace(/^\s*(?:EXTRA_IMAGES|ASSETS)\s*:\s*[[{][\s\S]*?[\]}]\s*;?\s*$/gm, "").trim();
  return code;
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
function cropExtraImages(rawResponseText, targetPaths, outDir, pythonBin) {
  const match = rawResponseText.match(/EXTRA_IMAGES:\s*(\[[\s\S]*?\])/);
  if (!match) return;
  let entries;
  try {
    entries = JSON.parse(match[1]);
  } catch {
    return;
  }
  // Quand on reproduit un template entier, une découpe est relative à UNE
  // page précise : ses coordonnées n'ont de sens que dans le repère de cette
  // page-là. `page` vaut 1 par défaut (cas mono-page, et modèle qui l'omet).
  for (const { index, x, y, width: w, height: h, page } of entries) {
    if (index == null || x == null || y == null || !w || !h) continue;
    const pageNum = Number.isInteger(page) && page >= 1 ? page : 1;
    const targetPath = targetPaths[pageNum - 1] || targetPaths[0];
    const bgPath = path.join(outDir, `background-layer-${pageNum}.png`);
    const sourcePath = fs.existsSync(bgPath) ? bgPath : targetPath;
    const outPath = path.join(outDir, `extracted-${index}.png`);
    const result = spawnSync(pythonBin, [
      path.join(PIPELINE_ROOT, "crop_image.py"), sourcePath, String(x), String(y), String(w), String(h), outPath,
      // Source de repli, utilisée UNIQUEMENT si la découpe ressort blanche :
      // certaines icônes du PDF sont des glyphes de texte (un ☎ dans une
      // police de symboles), absents du calque décor. Un aplat de couleur,
      // lui, est du contenu légitime et reste pris dans le calque -- c'est
      // ce que distingue is_blank() dans crop_image.py.
      targetPath,
    ], { encoding: "utf-8" });
    if (result.status !== 0) continue;
  }
}

/** Correspondance déclarée par le modèle entre ses clés d'assets et les
 * images extraites (`ASSETS:{"page_bg": 1, ...}`). Écrite à côté du JSX pour
 * que le rendu puisse construire la prop `assets` -- sans elle, le composant
 * s'afficherait sans aucune image, sans que rien ne le signale. */
function saveAssetsMap(rawResponseText, outDir) {
  const match = rawResponseText.match(/ASSETS:\s*(\{[\s\S]*?\})/);
  if (!match) return null;
  try {
    const map = JSON.parse(match[1]);
    const file = path.join(outDir, "assets-map.json");
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
    return map;
  } catch {
    return null;
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
  if (IS_MOONSHOT && !process.env.MOONSHOT_API_KEY)
    throw new Error("MOONSHOT_API_KEY manquante. Ajoute-la dans pipeline/.env (modèle actuel : " + MODEL + ").");
  if (!IS_MOONSHOT && !process.env.ANTHROPIC_API_KEY)
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

  // --- Étape 1 : extraction (screenshots cibles + dictionnaire de style) ---
  // `pageNumber` vaut soit un numéro de page, soit "all" pour reproduire le
  // template ENTIER -- toutes les pages du PDF d'un coup.
  const allPages = String(pageNumber).toLowerCase() === "all";
  onProgress("extract", allPages
    ? "Génération des screenshots cibles et du dictionnaire HTML (toutes les pages)..."
    : `Génération du screenshot cible et du dictionnaire HTML (page ${pageNumber})...`);
  const venvPython = path.join(PROJECT_ROOT, "venv", "bin", "python3");
  const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";
  const extractResult = spawnSync(
    pythonBin,
    [path.join(PIPELINE_ROOT, "extract.py"), pdfPath, outDir, allPages ? "all" : String(pageNumber)],
    { encoding: "utf-8" }
  );
  if (extractResult.status !== 0)
    throw new Error(`Extraction échouée: ${extractResult.stderr}`);

  const extractLines = extractResult.stdout.trim().split("\n");
  const dictionaryPath = extractLines.find((l) => l.startsWith("DICTIONARY:")).slice("DICTIONARY:".length);
  const jinjaTagsPath = extractLines.find((l) => l.startsWith("JINJA_TAGS:"))?.slice("JINJA_TAGS:".length);
  const extractedImagesPath = extractLines.find((l) => l.startsWith("EXTRACTED_IMAGES:"))?.slice("EXTRACTED_IMAGES:".length);
  const targetPaths = extractLines.filter((l) => l.startsWith("TARGET:")).map((l) => l.slice("TARGET:".length));
  const targetPath = targetPaths[0];
  if (!targetPath)
    throw new Error("Aucune image cible produite par extract.py.");
  const pageCount = targetPaths.length;

  const { width, height } = pngDimensions(targetPath);
  const jinjaTags = jinjaTagsPath ? JSON.parse(fs.readFileSync(jinjaTagsPath, "utf-8")) : [];
  const extractedImages = extractedImagesPath ? JSON.parse(fs.readFileSync(extractedImagesPath, "utf-8")) : [];
  onProgress(
    "extract",
    `${pageCount} page(s) cible (${width}x${height}px), ${jinjaTags.length} tag(s) Jinja, ${extractedImages.length} image(s) extraite(s).`
  );

  // Calque décor : le fond de page SANS TEXTE que pdftohtml -c produit déjà
  // (formes vectorielles, dégradés, photos, logos composités). C'est la
  // seule référence fiable pour une décoration complexe -- la redessiner en
  // CSS échoue dès qu'elle sort du rectangle simple, et découper la capture
  // cible y figerait le texte Jinja brut. Normalisé à la taille exacte de la
  // cible pour que les coordonnées soient interchangeables.
  const backgroundPaths = targetPaths.map((_, i) => {
    const bgPath = path.join(outDir, `background-layer-${i + 1}.png`);
    const bgResult = spawnSync(
      pythonBin,
      [path.join(PIPELINE_ROOT, "extract_background.py"), dictionaryPath, bgPath, String(width), String(height), String(i + 1)],
      { encoding: "utf-8" }
    );
    return bgResult.status === 0 && fs.existsSync(bgPath) ? bgPath : null;
  });
  const hasBackground = backgroundPaths.some(Boolean);
  onProgress("extract", hasBackground
    ? `Calque décor (fond sans texte) extrait pour ${backgroundPaths.filter(Boolean).length}/${pageCount} page(s).`
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
  // Version réduite POUR L'ENVOI uniquement : ces images servent à être
  // reconnues, pas mesurées, et le coût vision est proportionnel au nombre
  // de pixels. Les fichiers réellement utilisés par le composant restent en
  // pleine résolution. On annonce quand même les dimensions d'origine, dont
  // l'IA a besoin pour calculer la bonne taille d'affichage.
  const visionDir = path.join(outDir, "vision");
  fs.mkdirSync(visionDir, { recursive: true });
  const extractedImageBlocks = topImages.flatMap((img) => {
    const idx = extractedImages.indexOf(img) + 1;
    const small = path.join(visionDir, `extracted-${idx}.png`);
    const shrunk = spawnSync(pythonBin, [path.join(PIPELINE_ROOT, "shrink_for_vision.py"), img.path, small], { encoding: "utf-8" });
    const sendPath = shrunk.status === 0 && fs.existsSync(small) ? small : img.path;
    return [
      { type: "text", text: `Image extraite extracted-${idx} (dimensions réelles ${img.width}x${img.height}px) :` },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(sendPath).toString("base64") } },
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
  // Une entrée par page cible. Le marqueur de cache est posé sur la DERNIÈRE
  // image : le cache ne s'accroche que sur un préfixe complet, donc le poser
  // sur la première laisserait les pages suivantes hors cache.
  const targetImageBlocks = targetPaths.flatMap((tp, i) => [
    ...(pageCount > 1 ? [{ type: "text", text: `PAGE ${i + 1}/${pageCount} -- image CIBLE :` }] : []),
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: fs.readFileSync(tp).toString("base64") },
      ...(i === pageCount - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    },
  ]);

  const anthropic = IS_MOONSHOT ? null : new Anthropic();
  const moonshot = IS_MOONSHOT
    ? new OpenAI({
        apiKey: process.env.MOONSHOT_API_KEY,
        baseURL: MOONSHOT_BASE_URL,
        // 40 minutes : Kimi produit ~48 tokens/s, et une passe 1 avec
        // réflexion approfondie dépasse régulièrement 20 minutes -- un run
        // a déjà été coupé alors qu'il finissait d'écrire son code.
        timeout: 40 * 60 * 1000,
      })
    : null;

  /** Traduit les blocs de contenu Anthropic vers le format OpenAI attendu par
   * l'API Moonshot : le texte reste du texte, une image base64 devient une
   * data URL. `cache_control` n'a pas d'équivalent et disparaît -- la mise en
   * cache est automatique côté Moonshot. */
  function toOpenAIContent(blocks) {
    return blocks.map((b) => {
      if (b.type === "image") {
        return {
          type: "image_url",
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        };
      }
      return { type: "text", text: b.text };
    });
  }

  async function callMoonshot(step, content, maxTokens) {
    const stream = await moonshot.chat.completions.create({
      model: MODEL,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: toOpenAIContent(content) }],
    });
    let textBuf = "";
    let thinkingBuf = "";
    let usage = null;
    // Pourquoi la génération s'est arrêtée : "length" = plafond de tokens
    // atteint, "stop" = le modèle a fini de lui-même. Sans cette information,
    // une réponse tronquée et une réponse vide se ressemblent.
    let finishReason = null;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      // Ce modèle sépare son raisonnement de sa réponse : on peut donc
      // afficher les deux distinctement, comme avec Claude.
      if (delta.reasoning_content) {
        thinkingBuf += delta.reasoning_content;
        onStream(step, "thinking", thinkingBuf.slice(-4000));
      }
      if (delta.content) {
        textBuf += delta.content;
        onStream(step, "text", textBuf.slice(-4000));
      }
    }
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: textBuf,
      finishReason,
      inputTokens: (usage?.prompt_tokens ?? 0) - cached,
      outputTokens: usage?.completion_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
    };
  }
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  const perPassUsage = [];

  async function callClaude(step, content, { maxTokens = 64000, effort = "high" } = {}) {
    onProgress(step, `Appel à ${MODEL}${IS_MOONSHOT ? "" : ` (effort ${effort})`}...`);

    if (IS_MOONSHOT) {
      const r = await callMoonshot(step, content, maxTokens);
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      totalCacheReadTokens += r.cacheRead;
      perPassUsage.push({
        step, effort: "n/a",
        inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheRead, cacheWriteTokens: 0,
        costUsd: Number(((r.inputTokens * RATE.in + r.outputTokens * RATE.out + r.cacheRead * 0.3) / 1e6).toFixed(4)),
      });
      onProgress(step, `Tokens: +${r.inputTokens} in / +${r.outputTokens} out (~$${perPassUsage.at(-1).costUsd}) [fin: ${r.finishReason ?? "?"}]`);
      if (r.finishReason === "length") {
        throw new Error(
          `Passe ${step} : réponse coupée au plafond de ${r.outputTokens} tokens de sortie (finish_reason="length"). `
          + `Le modèle n'a pas eu la place d'écrire le code après avoir réfléchi. `
          + `Ce n'est pas un dépassement de délai : l'API a bien répondu.`
        );
      }
      return r.text;
    }

    // En non-streaming, la réflexion étendue (activée par défaut sur Sonnet 5,
    // pas de budget_tokens séparable) peut consommer tout le max_tokens sans
    // laisser de place au JSX final -- déjà vu produire un fichier vide malgré
    // "usage.output_tokens" au plafond. Le streaming évite aussi les timeouts
    // HTTP sur un aussi gros max_tokens (recommandation officielle du SDK).
    // `effort` pilote la profondeur de réflexion, donc l'essentiel du coût :
    // la réflexion est facturée en tokens de SORTIE (15 $/M), et une passe
    // peut à elle seule en consommer des dizaines de milliers. Les images,
    // elles, pèsent ~20 000 tokens d'entrée par run, soit environ 0,06 $.
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort },
      messages: [{ role: "user", content }],
    });
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
    // Détail par passe : sans ça on optimise à l'aveugle, en devinant
    // laquelle coûte cher.
    perPassUsage.push({
      step,
      effort,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: Number((
        (msg.usage.input_tokens * RATE.in + msg.usage.output_tokens * RATE.out
          + cacheWrite * RATE.in * 1.25 + cacheRead * RATE.in * 0.1) / 1e6
      ).toFixed(4)),
    });
    onProgress(
      step,
      `Tokens: +${msg.usage.input_tokens} in / +${msg.usage.output_tokens} out (~$${perPassUsage.at(-1).costUsd})` +
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
    // Captures page par page, nécessaires pour comparer la page N du rendu à
    // la page N de la cible (le diff pixelmatch exige des tailles identiques,
    // ce que la capture empilée de toutes les pages ne donne pas).
    return (result.stdout || "")
      .split("\n")
      .filter((l) => l.startsWith("PAGE_RENDER:"))
      .map((l) => l.slice("PAGE_RENDER:".length).split(":").slice(1).join(":"));
  }

  const passes = [];

  // --- Passe 1 : premier jet (structure + layout) ---
  // Le Golden Reference (moteur + VisianTemplateHtml.jsx + schéma, ~15-20k
  // tokens) est identique à chaque appel, sur CE run comme sur tout autre
  // template -- isolé dans son propre bloc caché plutôt que noyé dans le
  // texte du prompt, pour que les appels suivants (page suivante, autre
  // template, dans la fenêtre de cache) le relisent à prix cassé.
  // Cadrage du périmètre : une seule page, ou le template entier. Les règles
  // qui suivent sont écrites au singulier ("la page") -- sans ce cadrage en
  // tête, un envoi multi-pages est lu comme plusieurs variantes de la même
  // page et le modèle n'en reproduit qu'une.
  const pageScopeText = pageCount > 1
    ? [
        `PÉRIMÈTRE : tu dois reproduire le template ENTIER, soit ${pageCount} pages. Les ${pageCount} images cibles te sont fournies ci-dessous, dans l'ordre, chacune annoncée par "PAGE k/${pageCount}".`,
        `Ce ne sont PAS ${pageCount} variantes de la même page ni ${pageCount} templates différents : c'est UN SEUL document, à rendre par UN SEUL composant.`,
        `Attention à ne pas confondre deux choses : le NOMBRE de pages du document final n'est pas figé -- c'est le moteur de pagination qui en émet autant que les vraies données l'exigent, et il peut donc y en avoir plus ou moins que ${pageCount}.`,
        `Ce que les images cibles te montrent, c'est l'HABILLAGE de chaque page (en-tête, pied de page, bandeaux, filigranes, marges) et l'ORDRE des sections. Si les pages 2 et suivantes partagent le même habillage, écris-le UNE fois et laisse le moteur le répéter ; ne code jamais "${pageCount} pages" en dur.`,
        `Si une page a un habillage à part (page de couverture, dernière page), reproduis-le comme tel.`,
        `Pour une découpe EXTRA_IMAGES, ajoute le champ "page" (1-${pageCount}) indiquant de quelle page viennent les coordonnées : EXTRA_IMAGES:[{"index": 10, "page": 2, "x": 1050, "y": 15, "width": 90, "height": 70}]. Sans ce champ, la découpe est faite sur la page 1.`,
      ].join("\n")
    : "PÉRIMÈTRE : une seule page t'est fournie, tu ne reproduis que celle-là.";

  const [pass1Before, pass1After] = readPromptTemplate("pass1.md").split("{{GOLDEN_REFERENCE}}").map((part) =>
    part
      .replace(/\{\{PAGE_SCOPE\}\}/g, pageScopeText)
      .replace(/\{\{CANVAS_SIZE\}\}/g, `${width} x ${height}`)
      .replace(/\{\{JINJA_TAGS\}\}/g, jinjaTagsText)
      .replace(/\{\{EXTRACTED_IMAGES\}\}/g, extractedImagesText)
  );
  const backgroundImageBlocks = backgroundPaths.flatMap((bgPath, i) => bgPath
    ? [
        { type: "text", text: `CALQUE DÉCOR${pageCount > 1 ? ` DE LA PAGE ${i + 1}/${pageCount}` : ""} (même repère que l'image cible, ${width} x ${height}) -- toutes les formes/photos/logos de la page, SANS AUCUN TEXTE. C'est ta source pour toute découpe EXTRA_IMAGES${pageCount > 1 ? ` (utilise "page": ${i + 1} pour découper ici)` : ""} :` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(bgPath).toString("base64") } },
      ]
    : []);
  const jsx1Raw = await callClaude("pass1", [
    ...targetImageBlocks,
    { type: "text", text: pass1Before },
    { type: "text", text: goldenReference, cache_control: { type: "ephemeral" } },
    { type: "text", text: pass1After },
    ...backgroundImageBlocks,
    ...extractedImageBlocks,
  ], { effort: "high" }); // génération complète : c'est la passe qui mérite l'effort
  const jsx1 = extractCode(jsx1Raw);
  assertValidJsx(jsx1, "1");
  const jsx1Path = path.join(outDir, "attempt1.jsx");
  fs.writeFileSync(jsx1Path, jsx1);
  cropExtraImages(jsx1Raw, targetPaths, outDir, pythonBin);
  saveAssetsMap(jsx1Raw, outDir);
  placeExtractedImages(jsx1, outDir);
  const png1Path = path.join(outDir, "attempt1.png");
  onProgress("pass1", "Rendu de la tentative 1...");
  const pass1PagePaths = render(jsx1Path, png1Path);
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
    // Comparaison PAGE PAR PAGE : la capture empilée du rendu ne peut pas
    // être confrontée à une cible d'une seule page (pixelmatch exige des
    // dimensions identiques), et un écart sur la page 3 doit être visible
    // comme tel, pas noyé dans une image géante.
    const renderPagePaths = pass1PagePaths.length ? pass1PagePaths : [png1Path];
    const comparable = Math.min(pageCount, renderPagePaths.length);
    if (!comparable) throw new Error("aucune page rendue à comparer");

    pass2ImageBlocks = [];
    const ratios = [];
    for (let i = 0; i < comparable; i++) {
     // Une page qui échoue (dimensions inattendues, capture manquante) ne
     // doit pas priver la passe 2 des repères de toutes les autres.
     try {
      const suffix = pageCount > 1 ? `-p${i + 1}` : "";
      const targetGridPath = path.join(outDir, `target-grid${suffix}.png`);
      const renderGridPath = path.join(outDir, `attempt1-grid${suffix}.png`);
      const diffPath = path.join(outDir, `diff1${suffix}.png`);
      const diffGridPath = path.join(outDir, `diff1-grid${suffix}.png`);
      await addGridOverlay(targetPaths[i], targetGridPath, width, height);
      await addGridOverlay(renderPagePaths[i], renderGridPath, width, height);
      const diffStats = generateDiffImage(targetPaths[i], renderPagePaths[i], diffPath);
      await addGridOverlay(diffPath, diffGridPath, width, height);
      ratios.push(diffStats.diffRatio);
      const label = pageCount > 1 ? `PAGE ${i + 1}/${pageCount} -- ` : "";
      pass2ImageBlocks.push(
        { type: "text", text: `${label}Image 1 (CIBLE, grille de repères tous les 50px) :` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(targetGridPath).toString("base64") } },
        { type: "text", text: `${label}Image 2 (TON RENDU ACTUEL, même grille) :` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(renderGridPath).toString("base64") } },
        { type: "text", text: `${label}Image 3 (DIFFÉRENCE pixelmatch, rouge = écart, même grille) :` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(diffGridPath).toString("base64") } },
      );
     } catch (pageErr) {
      onProgress("pass2", `Page ${i + 1} : grille/diff impossible (${pageErr.message}) -- page ignorée dans la comparaison.`);
     }
    }
    if (!pass2ImageBlocks.length) throw new Error("aucune page comparable");

    // Un nombre de pages différent de la cible est en soi le plus gros écart
    // possible : il faut le dire explicitement, aucune image ne le montre.
    if (renderPagePaths.length !== pageCount) {
      pass2ImageBlocks.unshift({
        type: "text",
        text: `ÉCART MAJEUR À CORRIGER EN PRIORITÉ : la cible fait ${pageCount} page(s), ton rendu en produit ${renderPagePaths.length}. `
          + `Seules les ${comparable} première(s) sont comparées ci-dessous. Cherche la cause (contenu qui déborde, page fixe en trop, section absente) avant tout autre ajustement.`,
      });
    }
    onProgress("pass2", `Diff pixelmatch : ${ratios.map((r, i) => `page ${i + 1} ${(r * 100).toFixed(1)}%`).join(", ")} de pixels différents.`);
  } catch (err) {
    onProgress("pass2", `Grille/diff indisponible (${err.message}) -- repli sur l'envoi simple des 2 images.`);
    pass2ImageBlocks = [
      ...targetImageBlocks,
      { type: "text", text: "^ Image(s) 1 (CIBLE)." },
      { type: "text", text: "Image 2 (TON RENDU ACTUEL, toutes pages empilées) :" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(png1Path).toString("base64") } },
    ];
  }
  const pass2Prompt = readPromptTemplate("pass2.md")
    .replace(/\{\{PAGE_SCOPE\}\}/g, pageScopeText)
    .replace("{{JSX}}", jsx1)
    .replace("{{DICTIONARY}}", dictionaryCompact)
    .replace(/\{\{CANVAS_SIZE\}\}/g, `${width} x ${height}`);
  // Correction guidée par des repères visuels explicites (grille + diff) :
  // l'analyse est cadrée, elle n'a pas besoin de l'effort maximal.
  const jsx2Raw = await callClaude("pass2", [...pass2ImageBlocks, { type: "text", text: pass2Prompt }], { effort: "high" });
  const jsx2 = extractCode(jsx2Raw);
  assertValidJsx(jsx2, "2");
  const jsx2Path = path.join(outDir, "attempt2.jsx");
  fs.writeFileSync(jsx2Path, jsx2);
  cropExtraImages(jsx2Raw, targetPaths, outDir, pythonBin);
  saveAssetsMap(jsx2Raw, outDir);
  placeExtractedImages(jsx2, outDir);
  const png2Path = path.join(outDir, "attempt2.png");
  onProgress("pass2", "Rendu de la tentative 2...");
  render(jsx2Path, png2Path);
  passes.push({ name: "pass2", label: "Passe 2 -- diff visuel", jsxPath: jsx2Path, pngPath: png2Path, htmlPath: png2Path.replace(/\.png$/i, ".html") });
  onProgress("pass2", "OK");

  // --- Passe 3 : audit de câblage ---
  // Un contrôle algorithmique passe d'abord : s'il ne trouve rien, la passe
  // Claude est purement et simplement sautée. C'est la passe la plus chère
  // par rapport à ce qu'elle change (mesuré : 0,02 % des pixels), puisqu'elle
  // regénère tout le JSX en tokens de sortie.
  const findings = auditJsx(jsx2);
  const jsx3Path = path.join(outDir, "attempt3.jsx");
  const png3Path = path.join(outDir, "attempt3.png");
  let jsx3 = jsx2;

  if (!findings.length) {
    onProgress("pass3", "Contrôle automatique : aucun problème de câblage -- passe Claude évitée.");
    fs.copyFileSync(jsx2Path, jsx3Path);
    fs.copyFileSync(png2Path, png3Path);
    const html2 = png2Path.replace(/\.png$/i, ".html");
    if (fs.existsSync(html2)) fs.copyFileSync(html2, png3Path.replace(/\.png$/i, ".html"));
  } else {
    onProgress("pass3", `Contrôle automatique : ${findings.length} point(s) à corriger -- ${findings.map((f) => f.rule).join(", ")}`);
    const pass3Prompt = readPromptTemplate("pass3.md")
      .replace("{{JSX}}", jsx2)
      .replace("{{FINDINGS}}", findings.map((f, i) => `${i + 1}. [${f.rule}] ${f.message}`).join("\n"));
    const jsx3Raw = await callClaude("pass3", [{ type: "text", text: pass3Prompt }], { effort: "low" });
    jsx3 = extractCode(jsx3Raw);
    assertValidJsx(jsx3, "3");
    fs.writeFileSync(jsx3Path, jsx3);
    placeExtractedImages(jsx3, outDir);
    onProgress("pass3", "Rendu de la tentative 3...");
    render(jsx3Path, png3Path);
  }
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

    // --- Composant 0 : sécurité de débordement de texte ---
    // Le rendu est calibré sur les données d'exemple ; avec du contenu client
    // plus long, deux débordements distincts apparaissent -- la boîte sort de
    // son parent (enfant d'un flex non étiré, dimensionné sur son contenu) et
    // le texte sort de sa boîte (chaîne sans espace : email, URL, mot long).
    // Voir add_text_safety.mjs. Neutre sur le rendu nominal (diff pixel = 0).
    const safety = addTextSafety(jsxCurrent);
    if (safety.count > 0) {
      jsxCurrent = safety.jsx;
      changed = true;
      notes.push(`débordement texte : max-w-full/break-words ajoutés sur ${safety.count} éléments`);
    }

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
    outDir, targetPath, dictionaryPath, width, height, passes, perPassUsage,
    totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens,
  };
}
