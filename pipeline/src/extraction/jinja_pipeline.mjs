import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const VENV_PYTHON = path.join(PROJECT_ROOT, "venv", "bin", "python3");

const MODEL = "kimi-k3";
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

function getPython() {
  return fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
}

function extractText(file) {
  if (file.toLowerCase().endsWith(".docx")) {
    const result = spawnSync(getPython(), [path.join(__dirname, "docx_to_text.py"), file], { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`Extraction docx échouée: ${result.stderr}`);
    return result.stdout;
  }
  return fs.readFileSync(file, "utf-8");
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\n([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  return JSON.parse(raw);
}

function extractBlocks(text) {
  const blocks = [];
  const regex = /```(?:json|markdown|md)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function salvageJsonArray(text) {
  let t = text.trim();
  const fenced = t.match(/```(?:json)?\n([\s\S]*?)```/);
  if (fenced) t = fenced[1].trim();
  else t = t.replace(/^```json\n?/, "").replace(/```$/, "").trim();

  if (t.startsWith("[")) {
    const lastBrace = t.lastIndexOf("}");
    if (lastBrace !== -1) {
      const salvaged = t.substring(0, lastBrace + 1) + "]";
      try {
        return JSON.parse(salvaged);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

export async function runJinjaPipeline({ cvPath, outDir, onProgress }) {
  const apiKey = process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Clé API Moonshot manquante.");

  const client = new OpenAI({ apiKey, baseURL: MOONSHOT_BASE_URL });

  // 1. Extraction de texte du docx modèle
  onProgress("extract", "Extraction du texte du modèle de CV...");
  const cvText = extractText(cvPath);

  // Fichiers d'exemples
  const exampleConfig = fs.readFileSync(path.join(PROJECT_ROOT, "exemple-jinja", "extra-config-visian.json"), "utf-8");
  const exampleConfigText = fs.readFileSync(path.join(PROJECT_ROOT, "exemple-jinja", "extra-config-visian.json"), "utf-8");
  const exampleGlobal = fs.readFileSync(path.join(PROJECT_ROOT, "exemple-jinja", "Visian - Global Data Prompt.md"), "utf-8");
  const exampleExp = fs.readFileSync(path.join(PROJECT_ROOT, "exemple-jinja", "Visian - Experience Data Prompt.md"), "utf-8");
  const sampleCvData = fs.readFileSync(path.join(PROJECT_ROOT, "pipeline", "sample_cvdata.json"), "utf-8");
  
  onProgress("extract", "Extraction du texte du template Jinja d'exemple...");
  const exampleTemplatePath = path.join(PROJECT_ROOT, "exemple-jinja", "Template_Visian_pWLzXxC.docx");
  const exampleTemplateText = extractText(exampleTemplatePath);

  // === PASSE 1 : REPLACEMENTS ===
  onProgress("pass1", "Passe 1/3 : Mapping Jinja du document...");
  const sysPass1 = fs.readFileSync(path.join(__dirname, "../../prompts/jinja_pass1_replacements.md"), "utf-8")
    .replace("{SAMPLE_CVDATA}", sampleCvData)
    .replace("{CV_TEXT}", cvText)
    .replace("{EXAMPLE_TEMPLATE_TEXT}", exampleTemplateText);

  const resPass1 = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: sysPass1 }],
  });

  let replacementsObj;
  try {
    replacementsObj = extractJson(resPass1.choices[0].message.content);
  } catch(e) {
    replacementsObj = salvageJsonArray(resPass1.choices[0].message.content);
    if (!replacementsObj) {
      throw new Error("Passe 1 échouée : JSON Invalide. " + e.message + "\nRéponse brute : " + resPass1.choices[0].message.content);
    }
    console.warn("Passe 1 : JSON tronqué récupéré avec succès (" + replacementsObj.length + " éléments).");
  }

  const replacementsStr = JSON.stringify(replacementsObj || [], null, 2);
  const replacementsOut = path.join(outDir, "replacements.json");
  fs.writeFileSync(replacementsOut, replacementsStr);


  // === PASSE 2 : EXTRA CONFIG ===
  onProgress("pass2", "Passe 2/3 : Génération de l'extra_config...");
  const sysPass2 = fs.readFileSync(path.join(__dirname, "../../prompts/jinja_pass2_config.md"), "utf-8")
    .replace("{SAMPLE_CVDATA}", sampleCvData)
    .replace("{EXAMPLE_CONFIG}", exampleConfigText)
    .replace("{CV_TEXT}", cvText)
    .replace("{REPLACEMENTS}", replacementsStr);

  const resPass2 = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: sysPass2 }],
  });

  let extraConfigObj;
  try {
    extraConfigObj = extractJson(resPass2.choices[0].message.content);
  } catch(e) {
    throw new Error("Passe 2 échouée : JSON Invalide. " + e.message);
  }
  const extraConfigStr = JSON.stringify(extraConfigObj, null, 2);
  const configOut = path.join(outDir, "extra_config.json");
  fs.writeFileSync(configOut, extraConfigStr);


  // === PASSE 3 : PROMPTS MARKDOWN ===
  onProgress("pass3", "Passe 3/3 : Génération des prompts d'extraction...");
  const sysPass3 = fs.readFileSync(path.join(__dirname, "../../prompts/jinja_pass3_prompts.md"), "utf-8")
    .replace("{EXAMPLE_GLOBAL}", exampleGlobal)
    .replace("{EXAMPLE_EXP}", exampleExp)
    .replace("{SAMPLE_CVDATA}", sampleCvData)
    .replace("{EXTRA_CONFIG}", extraConfigStr)
    .replace("{CV_TEXT}", cvText);

  const resPass3 = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: sysPass3 }],
  });

  const blocksPass3 = extractBlocks(resPass3.choices[0].message.content);
  if (blocksPass3.length < 2) throw new Error("Passe 3 échouée : Prompts manquants.");
  const globalPromptText = blocksPass3[0];
  const expPromptText = blocksPass3[1];

  const globalPromptOut = path.join(outDir, "global_prompt.md");
  const expPromptOut = path.join(outDir, "experience_prompt.md");
  fs.writeFileSync(globalPromptOut, globalPromptText || "");
  fs.writeFileSync(expPromptOut, expPromptText || "");

  // 5. Modification du .docx
  onProgress("render", "Génération finale du template .docx...");
  const templateOutPath = path.join(outDir, "template.docx");
  const renderResult = spawnSync(getPython(), [
    path.join(__dirname, "replace_in_docx.py"),
    cvPath,
    replacementsOut,
    templateOutPath
  ], { encoding: "utf-8" });

  if (renderResult.status !== 0) {
    throw new Error(`Erreur génération docx: ${renderResult.stderr || renderResult.stdout}`);
  }

  onProgress("done", "Terminé");
  return { 
    templatePath: templateOutPath,
    globalPromptPath: globalPromptOut,
    experiencePromptPath: expPromptOut,
    configPath: configOut
  };
}
