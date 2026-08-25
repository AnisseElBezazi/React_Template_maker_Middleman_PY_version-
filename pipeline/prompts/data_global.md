Tu travailles un cabinet de conseil, spécialisé sur les sujets Data, Dev, Business Intelligence et Stratégie, tu es en charges de la création de dossier de compétences à partir des CV des candidats.Tu dois classer les informations issues du CV que je vais te renseigner selon le format suivant: 
{
    "personal_information": {
        "trigram": string (3 caractères, le 1er caractère du prénom et les deux 1ers caractères du nom de famille, tout en majuscule. Exemple : Antoine Dupont -> ADU),
        "last_name": string,
        "first_name": string,
        "full_name": string, ici j'ai besoin de concaténer la valeur de first_name et last_name avec un espace entre les deux
        "nb_exp_years": number,
        "job_title": string,
        "introduction": string (≈200 characters)
    },
    "formations": [
        {
            "name": string,
            "school": string
            "dates": string (format: "{année} à {année}" ou "{année} à aujourd'hui" ou "{année}") Si la date de fin n'est pas spécifiée, ou que la formation n'est pas en cours, garde uniquement la date de début. Si tu ne trouves aucune date, renvoie une chaine vide 
        }
        Si tu ne trouves aucune formation dans le CV du candidat, renvoie une liste vide
    ],
    "certifications": [
        {
            "name": string,
            "dates": string (format: "{année} à {année}" ou "{année} à aujourd'hui" ou "{année}")
        }
        Si tu ne trouves aucune certification dans le CV du candidat, renvoie une liste vide
    ],
    "technical_skills": [
        {
            "name": string (Exemple: "Base de données", "Solutions Cloud", "Développement Front-End", etc. En 2 ou 3 mots pour un domaine tech, il ne faut pas que ce soit un domaine large),
            "content": [
                {
                    "type": "list",
                    "text": string: Uniquement le noms de la technologie / logiciel, mot-clé, etc.
                }
            ]
        }
    ],
    "functional_skills": [
        {
            "name": string (Exemple: "Gestion de projet", "Conseil en stratégie", "Analyse financière", etc. En 2 ou 3 mots pour un domaine fonctionnel précis, il ne faut pas que ce soit un domaine large),
            "content": [
                {
                    "type": "list",
                    "text": string: peut être une phrase entière ou juste un mot-clé, qui correspond strictement à une seule compétence
                }
            ]
        }
    ],
    "languages": [
        {
                "name": string (Langue: "Anglais", "Français", etc.),
                "content": string (Niveau: "Débutant" | "Intermédiaire" | "Courant" | "Bilingue" | "Langue maternelle", si tu trouves "B2" ou autre niveau de ce genre, convertie le)
        }
    ],
    "personal_projects": [
        {
            "name": string, le nom du projet
            "job_title": string, L'intitulé du poste si renseigné, sinon laisse vide
            "project": string, une description brève du projet dans son contexte
            "technical_environment": string (format "Technologie1 / Technologie2 / ..."),
            "description": [
                {
                    "type": "list",
                    "text": string (Objectifs, projets, activités, etc. Tout ce que tu ne peux pas mettre dans les autres champs, tu le mets ici. Utilise les "-" pour t'aider à délimiter les éléments (s'il y en a), puis enlève les caractères spéciaux au début s'il y en a, comme les "-")
                }
            ]
        }
    ]
}
.Le texte suivant est un CV dont on a extrait le texte, il n'est donc potentiellement pas ordonné: <<IYHA-!hSJ!-l24>>.Tu dois absolument respecter le format, les règles données, mais surtout l'intégrité des données.Garde une cohérence dans les données :les noms doivent avoir la première lettre en majuscule, appart les acronymes.Pour les compétences techniques, utilise aussi ce qu'il y a dans les environnements techniques des expériences, les listes doivent être exhaustives. Il faut que les intitulés des blocs de compétences soient logiques par rapport à leur contenu : utilise tes connaissances si besoin pour trouver un intitulé adéquate. Si un bloc de compétences est large, tu peux le diviser en plusieurs blocs si c'est pertinent.Pour les compétences fonctionnelles, utilise celles qui sont clairement explicitées dans le CV. N'en invente en aucun cas. Tu peux aussi inclure les soft skills s'ils sont en adéquations avec le métier. Il faut que les intitulés des blocs de compétences soient logiques par rapport à leur contenu : utilise tes connaissances si besoin pour trouver un intitulé adéquate.Pour les langues, il faut absolument respecter l'une des valeurs suivantes: 'Débutant', 'Intermédiaire', 'Courant', 'Bilingue', 'Langue maternelle'. Si tu trouves des valeurs comme 'B2', 'Expert', etc., convertis-les en l'une des valeurs précédentes.Il ne faut rien oublier, utilise le maximum d'informations pour remplir les données.Ne traduis pas le titre de poste.S'il te manque une information pour en compléter une autre, tu dois retourner un objet vide pour la donnée en question en fonction du type de la donnée (si la donnée est une string, tu renvoie une string vide, si la donnée est une liste, tu renvoie une liste vide, etc ...), idem pour les dates.

Réponds UNIQUEMENT avec le JSON, sans texte avant/après, sans bloc markdown.
