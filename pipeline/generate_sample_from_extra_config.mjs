// Transforme un extra_config CV Smart (schéma décrivant le formulaire
// d'édition -- voir CvParserConfig.extra_config côté backend) en un exemple
// de cvData réaliste. Sert deux usages en même temps : (a) injecté dans le
// prompt de la passe 1 comme référence exacte des noms de champs pour CE
// template précis (au lieu du schéma générique sample_cvdata.json, qui ne
// correspond pas forcément à un client donné), et (b) utilisé tel quel pour
// le rendu de prévisualisation Puppeteer, afin que l'aperçu affiche du texte
// plausible plutôt que des placeholders entre crochets (moins lisible pour
// juger le rendu visuel réel).
//
// Usage CLI (test local) : node generate_sample_from_extra_config.mjs <extra_config.json>

// Valeurs connues, indexées par "section.champ" (section = data_name du
// bloc top-level, champ = data_name du champ à l'intérieur) -- reprend les
// mêmes exemples que sample_cvdata.json pour rester cohérent. Chaque entrée
// est une liste (une valeur différente par occurrence si plusieurs entrées
// section_array/key_values_array sont générées).
const CONTEXTUAL = {
  "personal_information.trigram": ["JMA"],
  "personal_information.full_name": ["Jeanne Martin"],
  "personal_information.first_name": ["Jeanne"],
  "personal_information.last_name": ["Martin"],
  "personal_information.job_title": ["Consultante Senior Data & IA"],
  "personal_information.nb_exp_years": ["8"],
  "personal_information.nb_school_years": ["5"],
  "personal_information.introduction": [
    "Consultante spécialisée dans la mise en place de plateformes data pour des clients grands comptes du secteur bancaire et assurance.",
  ],
  "personal_information.availability": ["Disponible sous 2 semaines"],
  "personal_information.current_date": [new Date().toLocaleDateString("fr-FR")],

  "formations.name": ["Master Data Science", "Ingénieur généraliste"],
  "formations.school": ["Université Paris-Dauphine", "École Centrale de Lyon"],
  "formations.dates": ["2017 à 2019", "2014 à 2017"],
  "formations.specialisation": ["Spécialité Intelligence Artificielle", "Spécialité Systèmes d'Information"],

  "certifications.name": ["AWS Certified Solutions Architect", "Microsoft Certified: Azure Data Engineer"],
  "certifications.certifier": ["Amazon Web Services", "Microsoft"],
  "certifications.dates": ["2022", "2021"],

  "languages.name": ["Français", "Anglais"],
  "languages.content": ["Langue maternelle", "Courant"],

  "experiences.company": ["Entreprise Alpha", "Entreprise Beta"],
  "experiences.period": ["Janvier 2022 à aujourd'hui", "Mars 2019 à Décembre 2021"],
  "experiences.job_title": ["Consultante Senior Data", "Consultante Data"],
  "experiences.projects_context": [
    "Refonte de la plateforme data d'un grand groupe bancaire, migration vers le cloud Azure.",
    "Programme de conformité réglementaire pour un acteur de l'assurance.",
  ],
  "experiences.team_and_methodology": [
    "Équipe de 5 personnes en méthodologie Agile/Scrum, sprints de 2 semaines.",
    "Équipe de 3 personnes, méthodologie Kanban.",
  ],
  "experiences.technical_environment": ["Python / Azure Data Factory / Power BI / SQL Server", "Python / SQL"],

  "personal_projects.name": ["Analyse de données sportives"],
  "personal_projects.job_title": ["Projet personnel"],
  "personal_projects.project": ["Application de visualisation de statistiques de course à pied connectée à l'API Strava."],
  "personal_projects.technical_environment": ["Python / Streamlit"],
};

// Fallback générique par mot-clé dans le nom du champ (data_name ou
// display_name, normalisés) quand aucune entrée contextuelle ne correspond.
const KEYWORD_FALLBACKS = [
  [/\bemail\b|e-?mail/, "contact@exemple.fr"],
  [/\bphone\b|t[ée]l[ée]phone|\btel\b/, "+33 1 23 45 67 89"],
  [/\bdate\b/, () => new Date().toLocaleDateString("fr-FR")],
  [/ann[ée]e|\byear\b|anciennet[ée]/, "5"],
  [/\bville\b|\bcity\b/, "Lyon"],
  [/\bpays\b|\bcountry\b/, "France"],
  // "\bfonction\b" ne matche PAS "fonctionnelles" (pas de frontière de mot
  // entre "fonction" et "nelles") -- bug déjà rencontré : "compétences
  // fonctionnelles" tombait à tort sur l'exemple de titre de poste.
  [/\btitre\b|\btitle\b|\bposte\b|\bfonction\b/, "Consultant Senior"],
  [/\bnom\b|\bname\b/, "Exemple"],
  [/description|contexte|context|r[ée]alisation/, "Exemple de réalisation menée dans ce cadre."],
  [/[ée]cole|\bschool\b|universit[ée]|formation/, "École Exemple"],
  [/entreprise|soci[ée]t[ée]|\bcompany\b|\bclient\b/, "Entreprise Exemple"],
  [/niveau|\blevel\b/, "Courant"],
];

function fallbackValue(dataName, displayName) {
  const haystack = `${dataName} ${displayName || ""}`.toLowerCase();
  for (const [pattern, value] of KEYWORD_FALLBACKS) {
    if (pattern.test(haystack)) return typeof value === "function" ? value() : value;
  }
  return displayName || dataName;
}

function contextualValue(sectionDataName, item, seed) {
  const key = `${sectionDataName}.${item.data_name}`;
  const list = CONTEXTUAL[key];
  if (list && list.length) return list[seed % list.length];
  return fallbackValue(item.data_name, item.display_name);
}

function leafValue(sectionDataName, item, seed) {
  if (item.data_type === "array") {
    const base = contextualValue(sectionDataName, item, seed);
    return [
      { type: "paragraph", text: base },
      { type: "paragraph", text: fallbackValue(item.data_name, item.display_name) },
    ];
  }
  return contextualValue(sectionDataName, item, seed);
}

function genOrderedArray(section) {
  const obj = {};
  for (const item of section.items || []) {
    if (!item.data_name) continue;
    obj[item.data_name] = leafValue(section.data_name, item, 0);
  }
  return obj;
}

function genKeyValuesEntry(section, i) {
  const keyField = section.item_config?.key || "key";
  const valueField = section.item_config?.value || "value";
  const keyConfig = section.item_config?.key_config;
  const valueConfig = section.item_config?.value_config;
  const valueIsArray = valueConfig?.data_type === "array";

  // key_values_choices (ou toute section avec des listes fermées) : utilise
  // les VRAIES options du schéma -- bug déjà rencontré en les ignorant : une
  // section "languages" avec choices ["Français","Anglais",...] affichait
  // quand même les exemples génériques "Langages/Cloud" prévus pour des
  // compétences techniques, quelle que soit la section réelle.
  if (Array.isArray(keyConfig?.choices) && keyConfig.choices.length) {
    const keyVal = keyConfig.choices[i % keyConfig.choices.length];
    const valueVal = Array.isArray(valueConfig?.choices) && valueConfig.choices.length
      ? valueConfig.choices[i % valueConfig.choices.length]
      : `[${valueConfig?.placeholder || "Valeur"}]`;
    return { [keyField]: keyVal, [valueField]: valueVal };
  }

  const keyExamples = ["Langages", "Cloud", "Bases de données"];
  const valueExamples = [
    ["Python", "SQL", "JavaScript"],
    ["Azure", "AWS"],
    ["PostgreSQL", "MongoDB"],
  ];
  return {
    [keyField]: keyExamples[i % keyExamples.length],
    [valueField]: valueIsArray
      ? valueExamples[i % valueExamples.length].map((text) => ({ type: "list", text }))
      : valueExamples[i % valueExamples.length][0],
  };
}

function genSectionArrayEntry(section, i) {
  const obj = {};
  for (const item of section.section_config?.items || []) {
    if (!item.data_name) continue;
    obj[item.data_name] = leafValue(section.data_name, item, i);
  }
  return obj;
}

// `cv_name`/`cv_job_title`/`cv_file_prefix` (chemins pointés en tête
// d'extra_config) référencent des champs qui doivent exister dans le vrai
// json_data, mais ne sont pas forcément listés dans frontend_cvparser_config
// (qui ne décrit QUE les champs éditables du formulaire -- un champ dérivé
// comme "full_name" peut exister côté données sans jamais y apparaître).
// Bug déjà rencontré : "personal_information.full_name" absent du JSON
// généré alors que le PDF cible l'utilise, parce qu'il n'était nulle part
// dans frontend_cvparser_config.
function ensurePath(result, dottedPath) {
  if (!dottedPath || typeof dottedPath !== "string") return;
  const parts = dottedPath.split(".");
  let obj = result;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== "object" || obj[parts[i]] === null) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (obj[leaf] !== undefined) return;

  // Cas fréquent : un "full_name" dérivé de first_name + last_name déjà générés.
  if (leaf === "full_name" && typeof obj.first_name === "string" && typeof obj.last_name === "string") {
    obj[leaf] = `${obj.first_name} ${obj.last_name}`;
    return;
  }
  obj[leaf] = fallbackValue(leaf, leaf);
}

export function generateSampleCvData(extraConfig) {
  const result = {};
  for (const section of extraConfig.frontend_cvparser_config || []) {
    const { data_name, data_type } = section;
    if (!data_name) continue;
    switch (data_type) {
      case "ordered_array":
        result[data_name] = genOrderedArray(section);
        break;
      case "key_values_array":
      case "key_values_choices":
        result[data_name] = [genKeyValuesEntry(section, 0), genKeyValuesEntry(section, 1)];
        break;
      case "section_array":
        result[data_name] = [genSectionArrayEntry(section, 0), genSectionArrayEntry(section, 1)];
        break;
      default:
        result[data_name] = null; // data_type non reconnu -- ne bloque pas le reste de la génération
    }
  }
  ensurePath(result, extraConfig.cv_name);
  ensurePath(result, extraConfig.cv_job_title);
  ensurePath(result, extraConfig.cv_file_prefix);
  return result;
}

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const extraConfig = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
  console.log(JSON.stringify(generateSampleCvData(extraConfig), null, 2));
}
