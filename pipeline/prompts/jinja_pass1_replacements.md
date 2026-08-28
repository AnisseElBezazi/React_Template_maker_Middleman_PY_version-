Tu es un expert Jinja2.

Le système extrait les données d'un CV vers un objet JSON structuré. 
Voici la structure standard des données extraites :
<schema-de-base>
{SAMPLE_CVDATA}
</schema-de-base>


Voici le texte du modèle de CV cible (avec ses données factices) :
<cv-text>
{CV_TEXT}
</cv-text>

Voici un exemple du texte d'un AUTRE CV qui a déjà été rempli avec des balises Jinja. Inspire-toi de cet exemple pour comprendre comment formater tes balises de remplacement (notamment pour les boucles) :
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
