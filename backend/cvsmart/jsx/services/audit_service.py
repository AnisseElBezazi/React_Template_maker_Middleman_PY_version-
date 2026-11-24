import re

# Conventions exactes du systeme CV Smart reel.
GROUPED = ["personal_information", "technical_skills", "functional_skills", "formations", "languages"]
INDEXED = ["experiences", "personal_projects", "certifications", "experiences_summary"]


def audit_jsx(code: str) -> list[dict]:
    """Controles MECANIQUES du composant genere : conventions data-block-id,
    texte code en dur, acces non securises a cvData, plafond de largeur.

    Ce sont des verifications deterministes qu'un script fait mieux et
    gratuitement : les confier a une passe Claude coutait une regeneration
    complete du JSX (facturee en tokens de sortie) pour un rendu inchange."""
    findings = []

    def add(rule, message):
        findings.append({"rule": rule, "message": message})

    for field in GROUPED:
        if re.search(rf"data-block-id=\{{?`?{field}-\$?\{{?\d", code):
            add("block-id-granularite",
                f'"{field}" est un bloc GROUPE : il doit porter un seul data-block-id="{field}" '
                f"pour toute la section, jamais un identifiant par element.")
    for field in INDEXED:
        if re.search(f'data-block-id="{field}"', code):
            add("block-id-granularite",
                f'"{field}" est un bloc INDEXE : chaque element doit porter '
                f'data-block-id="{field}-<index>", pas un identifiant unique pour toute la liste.')

    unsafe = list(dict.fromkeys(m.group(0) for m in re.finditer(r"cvData\.(\w+)", code)))
    if unsafe:
        add("acces-non-securise",
            f"Acces sans optional chaining : {', '.join(unsafe)}. "
            f"Utilise cvData?.champ pour ne pas planter sur des donnees partielles.")

    if re.search(r"cvData\??\.\s*user\b", code):
        add("champ-invente",
            "cvData.user n'existe pas dans le schema reel. Les coordonnees du commercial "
            "viennent de useSelector(state => state.auth.saleInfo), qui n'expose que email et phone_number.")
    if re.search(r"saleInfo\?\.\s*(first_name|last_name|name)\b", code):
        add("champ-invente", "saleInfo n'expose que email et phone_number : first_name / last_name n'existent pas.")

    return findings


def overflow_findings(overflow: list[dict]) -> list[dict]:
    """Constats MESURES au rendu (render_service.OVERFLOW_JS) : une page dont le
    texte sort du cadre. Meme format que audit_jsx, pour la passe 3."""
    return [{
        "rule": "debordement-page",
        "message": (
            f"La page {item['page']} du rendu DEBORDE de {item['over']}px sous son cadre "
            f"(premier texte concerne : \"{item['sample']}\"). Une couverture ou une premiere page ne doit "
            f"jamais contenir une liste de longueur variable dans un bloc a hauteur fixe : passe son contenu "
            f"par PaginatedEntryPages (un item par bloc ou par entree, renderPageChrome avec un compteur de "
            f"pages pour l'habillage de la page 1) afin que l'exces passe sur la page suivante "
            f"au lieu de sortir de la page ou d'etre coupe."
        ),
    } for item in overflow]
