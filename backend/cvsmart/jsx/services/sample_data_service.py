import json
import re
from datetime import date

from cvsmart.shared.paths_service import PIPELINE_SAMPLE_CVDATA

DATA_REF_RE = re.compile(r"\bdata\.(\w+)")

# Valeurs connues, indexees par "section.champ" (section = data_name du bloc
# top-level, champ = data_name du champ a l'interieur) -- reprend les memes
# exemples que sample_cvdata.json pour rester coherent. Chaque entree est une
# liste (une valeur differente par occurrence si plusieurs entrees
# section_array/key_values_array sont generees).
CONTEXTUAL = {
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
    "personal_information.current_date": [date.today().strftime("%d/%m/%Y")],

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

    # Champs rencontres sur les templates reels : sans entree dediee, le
    # repli renvoyait le LIBELLE du champ, ce qui donne un apercu ou l'on ne
    # distingue plus la donnee de son etiquette.
    "main_experiences.name": ["Societe Alpha", "Groupe Beta", "Cabinet Gamma"],
    "main_experiences.job_title": ["Consultant Senior Data", "Chef de projet SI", "Architecte Cloud"],
    "main_experiences.duration": ["3 ans", "2 ans", "18 mois"],

    "diplomas.type": ["Master", "Licence", "BTS"],
    "diplomas.domaine": ["Informatique", "Génie logiciel", "Réseaux"],
    "diplomas.school": ["Université Paris-Dauphine", "École Centrale de Lyon"],
    "diplomas.dates": ["2017 à 2019", "2014 à 2017"],

    "interventions_domains.text": ["Banque et assurance", "Secteur public", "Industrie"],
    "soft_skills.text": ["Esprit d'analyse", "Travail en équipe", "Autonomie"],
    "skills.name": ["Langages", "Cloud", "Bases de données"],

    "personal_projects.name": ["Analyse de données sportives"],
    "personal_projects.job_title": ["Projet personnel"],
    "personal_projects.project": ["Application de visualisation de statistiques de course à pied connectée à l'API Strava."],
    "personal_projects.technical_environment": ["Python / Streamlit"],
}

# Fallback generique par mot-cle dans le nom du champ (data_name ou
# display_name, normalises) quand aucune entree contextuelle ne correspond.
KEYWORD_FALLBACKS = [
    (re.compile(r"\bemail\b|e-?mail"), "contact@exemple.fr"),
    (re.compile(r"\bphone\b|t[ée]l[ée]phone|\btel\b"), "+33 1 23 45 67 89"),
    # "dates" au pluriel designe presque toujours une PERIODE sur un CV
    # (formation, experience), pas une date isolee.
    (re.compile(r"\bdates\b|p[ée]riode"), "2017 à 2019"),
    (re.compile(r"\bdate\b"), lambda: date.today().strftime("%d/%m/%Y")),
    (re.compile(r"ann[ée]e|\byear\b|anciennet[ée]"), "5"),
    (re.compile(r"dur[ée]e|duration"), "2 ans"),
    (re.compile(r"niveau_anglais|english"), "Courant"),
    (re.compile(r"\bville\b|\bcity\b"), "Lyon"),
    (re.compile(r"\bpays\b|\bcountry\b"), "France"),
    # "\bfonction\b" ne matche PAS "fonctionnelles" (pas de frontiere de mot
    # entre "fonction" et "nelles") -- bug deja rencontre : "competences
    # fonctionnelles" tombait a tort sur l'exemple de titre de poste.
    (re.compile(r"\btitre\b|\btitle\b|\bposte\b|\bfonction\b"), "Consultant Senior"),
    (re.compile(r"description|contexte|context|r[ée]alisation"), "Exemple de réalisation menée dans ce cadre, avec un impact mesurable sur les indicateurs clés du projet."),
    (re.compile(r"[ée]cole|\bschool\b|universit[ée]|formation"), "École Exemple"),
    (re.compile(r"entreprise|soci[ée]t[ée]|\bcompany\b|\bclient\b"), "Entreprise Exemple"),
    # "nom/name" arrive APRES les regles specifiques : sinon "company_name" et
    # "school_name" tombaient sur le generique au lieu de leur vraie categorie.
    (re.compile(r"nom complet|full name"), "Jeanne Martin"),
    (re.compile(r"\bnom\b|\bname\b"), "Exemple"),
    (re.compile(r"niveau|\blevel\b"), "Courant"),
]


def fallback_value(data_name: str, display_name: str | None) -> str:
    # Les underscores sont remplaces par des espaces : sans ca, "full_name"
    # ne declenchait aucune regle (pas de frontiere de mot entre "_" et
    # "name"), et le repli renvoyait le nom du champ tel quel.
    haystack = re.sub(r"[_-]+", " ", f"{data_name} {display_name or ''}").lower()
    for pattern, value in KEYWORD_FALLBACKS:
        if pattern.search(haystack):
            return value() if callable(value) else value
    return display_name or data_name


def contextual_value(section_data_name: str, item: dict, seed: int):
    key = f"{section_data_name}.{item.get('data_name')}"
    values = CONTEXTUAL.get(key)
    if values:
        return values[seed % len(values)]
    return fallback_value(item.get("data_name"), item.get("display_name"))


def leaf_value(section_data_name: str, item: dict, seed: int):
    if item.get("data_type") == "array":
        base = contextual_value(section_data_name, item, seed)
        # Les deux items different de "type" (paragraph vs list) : la plupart
        # des templates reels rendent chaque type differemment (puce visible
        # ou non) -- ne jamais exercer "list" ici masquait ce rendu dans tout
        # aperçu genere depuis un extra_config.
        return [
            {"type": "paragraph", "text": base},
            {"type": "list", "text": fallback_value(item.get("data_name"), item.get("display_name"))},
        ]
    return contextual_value(section_data_name, item, seed)


def gen_ordered_array(section: dict) -> dict:
    obj = {}
    for item in section.get("items") or []:
        if not item.get("data_name"):
            continue
        obj[item["data_name"]] = leaf_value(section.get("data_name"), item, 0)
    return obj


def gen_key_values_entry(section: dict, i: int) -> dict:
    item_config = section.get("item_config") or {}
    key_field = item_config.get("key", "key")
    value_field = item_config.get("value", "value")
    key_config = item_config.get("key_config") or {}
    value_config = item_config.get("value_config") or {}
    value_is_array = value_config.get("data_type") == "array"

    # key_values_choices (ou toute section avec des listes fermees) :
    # utilise les VRAIES options du schema -- bug deja rencontre en les
    # ignorant : une section "languages" avec choices ["Francais",
    # "Anglais", ...] affichait quand meme les exemples generiques
    # "Langages/Cloud" prevus pour des competences techniques.
    key_choices = key_config.get("choices")
    if isinstance(key_choices, list) and key_choices:
        key_val = key_choices[i % len(key_choices)]
        value_choices = value_config.get("choices")
        if isinstance(value_choices, list) and value_choices:
            value_val = value_choices[i % len(value_choices)]
        else:
            value_val = f"[{value_config.get('placeholder', 'Valeur')}]"
        return {key_field: key_val, value_field: value_val}

    key_examples = ["Langages", "Cloud", "Bases de donnees"]
    value_examples = [
        ["Python", "SQL", "JavaScript"],
        ["Azure", "AWS"],
        ["PostgreSQL", "MongoDB"],
    ]
    value = value_examples[i % len(value_examples)]
    return {
        key_field: key_examples[i % len(key_examples)],
        value_field: [{"type": "list", "text": t} for t in value] if value_is_array else value[0],
    }


def gen_section_array_entry(section: dict, i: int) -> dict:
    obj = {}
    for item in (section.get("section_config") or {}).get("items") or []:
        if not item.get("data_name"):
            continue
        obj[item["data_name"]] = leaf_value(section.get("data_name"), item, i)
    return obj


def _ensure_path(result: dict, dotted_path: str | None) -> None:
    """cv_name/cv_job_title/cv_file_prefix (chemins pointes en tete
    d'extra_config) referencent des champs qui doivent exister dans le vrai
    json_data, mais ne sont pas forcement listes dans
    frontend_cvparser_config (qui ne decrit QUE les champs editables du
    formulaire -- un champ derive comme "full_name" peut exister cote
    donnees sans jamais y apparaitre)."""
    if not dotted_path or not isinstance(dotted_path, str):
        return
    parts = dotted_path.split(".")
    obj = result
    for part in parts[:-1]:
        if not isinstance(obj.get(part), dict):
            obj[part] = {}
        obj = obj[part]
    leaf = parts[-1]
    if leaf in obj:
        return

    # Cas frequent : un "full_name" derive de first_name + last_name deja generes.
    if leaf == "full_name" and isinstance(obj.get("first_name"), str) and isinstance(obj.get("last_name"), str):
        obj[leaf] = f"{obj['first_name']} {obj['last_name']}"
        return
    # Sinon on consulte d'abord la table des valeurs connues.
    known = CONTEXTUAL.get(dotted_path)
    obj[leaf] = known[0] if known else fallback_value(leaf, leaf)


def generate_sample_cv_data(extra_config: dict, jinja_tags: list[str] | None = None) -> dict:
    result: dict = {}
    for section in extra_config.get("frontend_cvparser_config") or []:
        data_name = section.get("data_name")
        data_type = section.get("data_type")
        if not data_name:
            continue
        if data_type == "ordered_array":
            result[data_name] = gen_ordered_array(section)
        elif data_type in ("key_values_array", "key_values_choices"):
            result[data_name] = [gen_key_values_entry(section, 0), gen_key_values_entry(section, 1)]
        elif data_type == "section_array":
            result[data_name] = [gen_section_array_entry(section, 0), gen_section_array_entry(section, 1)]
        else:
            result[data_name] = None  # data_type non reconnu -- ne bloque pas le reste

    # Champ reference par le VRAI template Jinja (`data.xxx`) mais absent de
    # CET extra_config precis : un extra_config incomplet, pas la preuve que
    # le champ n'existe pas cote CV Smart reel -- le composant genere, lui,
    # lit deja `cvData?.xxx` en se basant sur la vraie balise Jinja, pas sur
    # l'extra_config. On comble depuis le schema generique quand il connait
    # ce nom de champ, plutot que de laisser un trou dans l'apercu alors que
    # la section s'affichera bel et bien en production si elle est alimentee
    # par ailleurs.
    if jinja_tags:
        referenced = {m.group(1) for tag in jinja_tags for m in DATA_REF_RE.finditer(tag)}
        missing = referenced - result.keys()
        if missing:
            generic = json.loads(PIPELINE_SAMPLE_CVDATA.read_text(encoding="utf-8"))
            for name in missing:
                if name in generic:
                    result[name] = generic[name]

    _ensure_path(result, extra_config.get("cv_name"))
    _ensure_path(result, extra_config.get("cv_job_title"))
    _ensure_path(result, extra_config.get("cv_file_prefix"))
    return result
