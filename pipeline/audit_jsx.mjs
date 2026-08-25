// Contrôles MÉCANIQUES du composant généré : conventions data-block-id,
// texte codé en dur, accès non sécurisés à cvData, plafond de largeur.
//
// Intérêt : ce sont des vérifications déterministes qu'un script fait mieux
// et gratuitement. Les confier à une passe Claude coûtait une régénération
// complète du JSX (facturée en tokens de sortie, le poste dominant) alors
// que la passe ne changeait mesurablement rien au rendu.
//
// Usage CLI : node audit_jsx.mjs <fichier.jsx>

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Conventions exactes du système CV Smart réel.
const GROUPED = ["personal_information", "technical_skills", "functional_skills", "formations", "languages"];
const INDEXED = ["experiences", "personal_projects", "certifications", "experiences_summary"];

export function auditJsx(code) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });

  // 1. Le conteneur racine ne doit pas être plafonné : containerWidth
  // mesurerait moins que CANVAS_W, ce qui rétrécit tout le rendu.
  const rootMatch = code.match(/<div[^>]*ref=\{rootRef\}[^>]*className="([^"]*)"/);
  if (rootMatch && /\bmax-w-/.test(rootMatch[1])) {
    add("max-width-racine", `Le conteneur racine porte une classe max-w-* ("${rootMatch[1].match(/max-w-[^\s"]*/)[0]}") : elle plafonne la largeur mesurée et rétrécit tout le rendu. Remplace-la par w-full.`);
  }

  // 2. Granularité des data-block-id.
  for (const field of GROUPED) {
    const indexed = new RegExp(`data-block-id=\\{?\`?${field}-\\$?\\{?\\d`, "g");
    if (indexed.test(code))
      add("block-id-granularite", `"${field}" est un bloc GROUPÉ : il doit porter un seul data-block-id="${field}" pour toute la section, jamais un identifiant par élément.`);
  }
  for (const field of INDEXED) {
    const plainOnly = new RegExp(`data-block-id="${field}"`, "g");
    if (plainOnly.test(code))
      add("block-id-granularite", `"${field}" est un bloc INDEXÉ : chaque élément doit porter data-block-id="${field}-<index>", pas un identifiant unique pour toute la liste.`);
  }
  // 3. Accès à cvData sans optional chaining.
  const unsafe = [...code.matchAll(/cvData\.(\w+)/g)].map((m) => m[0]);
  if (unsafe.length)
    add("acces-non-securise", `Accès sans optional chaining : ${[...new Set(unsafe)].join(", ")}. Utilise cvData?.champ pour ne pas planter sur des données partielles.`);

  // 4. Champs inventés : tout accès à cvData.user (le vrai système passe par
  // useSelector(state => state.auth.saleInfo)).
  if (/cvData\??\.\s*user\b/.test(code))
    add("champ-invente", "cvData.user n'existe pas dans le schéma réel. Les coordonnées du commercial viennent de useSelector(state => state.auth.saleInfo), qui n'expose que email et phone_number.");
  if (/saleInfo\?\.\s*(first_name|last_name|name)\b/.test(code))
    add("champ-invente", "saleInfo n'expose que email et phone_number : first_name / last_name n'existent pas.");

  return findings;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const findings = auditJsx(fs.readFileSync(process.argv[2], "utf-8"));
  console.log(JSON.stringify(findings, null, 2));
}
