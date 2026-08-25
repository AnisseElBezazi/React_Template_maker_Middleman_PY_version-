// Génère un cvData.json à partir d'un vrai CV (docx ou txt), en utilisant
// les deux prompts exacts de production (pipeline/prompts/data_global.md
// et data_experiences.md) -- au lieu de données inventées à la main.
//
// Usage: node extract_cvdata.mjs <cv.docx|cv.txt> <out.json>

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PLACEHOLDER = "<<IYHA-!hSJ!-l24>>";
const MODEL = "claude-sonnet-5";

const [, , cvFile, outFile] = process.argv;
if (!cvFile || !outFile) {
  console.error("Usage: node extract_cvdata.mjs <cv.docx|cv.txt> <out.json>");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY manquante. Crée pipeline/.env avec ANTHROPIC_API_KEY=sk-...");
  process.exit(1);
}

function extractText(file) {
  if (file.toLowerCase().endsWith(".docx")) {
    const venvPython = path.join(PROJECT_ROOT, "venv", "bin", "python3");
    const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";
    const result = spawnSync(pythonBin, [path.join(__dirname, "docx_to_text.py"), file], { encoding: "utf-8" });
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

const cvText = extractText(path.resolve(cvFile));
console.log(`[extract] ${cvText.length} caractères de texte CV extraits.`);

const anthropic = new Anthropic();
let totalIn = 0, totalOut = 0;

async function callPrompt(name, promptFile) {
  const prompt = fs.readFileSync(path.join(__dirname, "prompts", promptFile), "utf-8").replace(PLACEHOLDER, cvText);
  console.log(`[${name}] Appel à Claude...`);
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  totalIn += msg.usage.input_tokens;
  totalOut += msg.usage.output_tokens;
  console.log(`[${name}] Tokens: +${msg.usage.input_tokens} in / +${msg.usage.output_tokens} out`);
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return extractJson(text);
}

const [globalData, experiencesData] = await Promise.all([
  callPrompt("global", "data_global.md"),
  callPrompt("experiences", "data_experiences.md"),
]);

const cvData = { ...globalData, ...experiencesData };
fs.writeFileSync(path.resolve(outFile), JSON.stringify(cvData, null, 2));
console.log(`\nOK -> ${outFile}`);
console.log(`Tokens totaux: ${totalIn} in / ${totalOut} out`);
