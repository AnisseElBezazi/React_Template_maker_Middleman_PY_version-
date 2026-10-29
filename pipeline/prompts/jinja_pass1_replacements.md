Tu es un expert Jinja2 et docxtpl (templating de documents Word).

Le système extrait les données d'un CV vers un objet JSON structuré.
Voici la structure standard des données extraites :
<schema-de-base>
{SAMPLE_CVDATA}
</schema-de-base>

**RÈGLE ABSOLUE de nommage -- TOUT vit sous `data.`, sans aucune exception :** le rendu réel passe l'intégralité de ces données sous UNE SEULE variable racine, `data` -- donc `data.personal_information.trigram`, `data.personal_information.full_name`, `data.experiences`, `data.certifications`, `data.technical_skills`, `data.formations`, `data.languages`, et TOUT champ que tu inventes toi-même (`data.loisirs`, directement -- il n'existe PAS de sous-espace du genre `custom.` : un champ inventé est un champ `data.` comme un autre). Le schéma ci-dessus montre la FORME des données (quels champs existent et comment ils s'organisent entre eux), pas la syntaxe Jinja à écrire : `personal_information` y apparaît à la racine du JSON, mais dans TES balises, il doit TOUJOURS être précédé de `data.`, exactement comme les autres sections. Oublier ce préfixe ne provoque AUCUNE erreur -- le champ s'affiche juste vide au rendu final en production, silencieusement.
Voici le texte du modèle de CV cible (avec ses données factices), UN PARAGRAPHE PAR LIGNE, précédé de son index entre crochets :
<cv-text>
{CV_TEXT}
</cv-text>

Voici ce même CV, déjà extrait automatiquement vers le schéma standard (mêmes prompts que la extraction CV Smart de production). Utilise ces valeurs comme point de départ fiable : pour chaque champ, retrouve dans `<cv-text>` le(s) paragraphe(s) qui contiennent cette valeur exacte (ou une valeur très proche — l'extraction peut légèrement reformuler), et mappe-les au champ correspondant. S'il manque des champs ici (extraction imparfaite ou balises non standard), ou si "(indisponible)" ci-dessous, continue de raisonner directement à partir de `<cv-text>` comme d'habitude — ceci est une aide, pas une source unique de vérité.

**Le champ `type` de `description`/`tasks` (`paragraph`/`list`/...) dans `<cvdata-extraite>` est SIMPLIFIÉ par ce prompt d'extraction interne -- il vaut quasiment toujours `"paragraph"`, littéralement, sans distinguer puce/sous-puce.** Ne t'en sers JAMAIS pour décider combien de branches `if/elif/else` construire ou quel type assigner à quel élément dans le TEMPLATE -- cette décision doit venir UNIQUEMENT de ce que tu observes toi-même dans `<cv-text>` (puces, sous-puces, indentation visibles dans le CV numéroté). `<cvdata-extraite>` sert à te dire QUELLES VALEURS existent et où les chercher, jamais QUELLE MISE EN FORME leur donner.
<cvdata-extraite>
{REAL_CVDATA}
</cvdata-extraite>

Voici un exemple du texte d'un AUTRE CV qui a déjà été rempli avec des balises Jinja/docxtpl. Utilise-le UNIQUEMENT comme référence de vocabulaire et de style de balises (noms de champs, ton des libellés) — pas comme modèle de structure de boucle à copier : ses boucles peuvent contenir des constructions propres à CE CV précis (branches conditionnelles, cas particuliers) qui ne généralisent pas. Les règles de boucle à suivre sont celles données plus bas, pas celles de cet exemple :
ATTENTION EN PARTICULIER : sa section de résumé tronqué (`experiences_summary`) branche sur `description | length == 0/1/2/...` pour s'adapter à une colonne étroite à hauteur fixe -- c'est un hack SPÉCIFIQUE à cette mise en page précise de CET exemple, PAS un patron à reproduire. Les règles de boucle universelles ci-dessous (jamais brancher sur la position ou la longueur) s'appliquent TOUJOURS, même là où cet exemple semble y déroger.
<exemple-jinja-template>
{EXAMPLE_TEMPLATE_TEXT}
</exemple-jinja-template>

**Mission :**
Génère un tableau JSON d'objets `{"search": "Texte Exact dans le CV Modèle", "replace": "{{ tag_jinja }}"}` pour mapper les données factices du CV vers les tags Jinja correspondants.

**IMPORTANT : Ce JSON représente exactement l'objet disponible dans Jinja !** 
Chaque clé du JSON correspond directement à une variable Jinja. 
- Exemple: Si le CV contient "Jeanne Martin" (qui correspond à `personal_information.full_name` dans le JSON), tu dois générer `{"search": "Jeanne Martin", "replace": "{{ personal_information.full_name }}"}`.

- Attention: le texte dans "search" doit être STRICTEMENT identique au texte du CV (copier-coller).
- **CRUCIAL : Si une information du CV cible ne correspond à aucun champ du `{SAMPLE_CVDATA}` standard, tu as l'autorisation d'inventer de nouvelles balises Jinja logiques (par exemple `custom.certifications` ou `custom.loisirs`). L'étape suivante de l'orchestration se basera sur tes inventions pour mettre à jour la configuration.**
- Pour les boucles (expériences, formations), utilise la syntaxe Jinja classique : `{"search": "Début de bloc", "replace": "{% for exp in experiences %}{{ exp.job_title }}"}` (avec le `{% endfor %}` à la fin).
- Ne renvoie RIEN D'AUTRE qu'un bloc de code JSON commençant par ```json.
