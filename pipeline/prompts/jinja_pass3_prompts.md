Tu es un expert en Prompt Engineering.

Le système utilise un "Global Prompt" et un "Experience Prompt" (écrits en Markdown) pour instruire un LLM d'extraire les données d'un CV et de les formater selon un schéma JSON précis (`extra_config`).

Voici un exemple de Global Prompt de référence :
<exemple-global>
{EXAMPLE_GLOBAL}
</exemple-global>

Voici un exemple de Experience Prompt de référence :
<exemple-experience>
{EXAMPLE_EXP}
</exemple-experience>

Voici la structure cible (`extra_config`) générée pour le nouveau CV :
<extra-config>
{EXTRA_CONFIG}
</extra-config>

Voici le texte du nouveau modèle de CV (données factices) :
<cv-text>
{CV_TEXT}
</cv-text>

**Mission :**
Rédige les 2 prompts adaptés pour ce nouveau modèle de CV, en te calquant EXACTEMENT sur le style et les règles des exemples fournis (ne change pas le fond, adapte juste les règles d'extraction si le schéma le nécessite).

Tu dois renvoyer EXACTEMENT 2 blocs de code Markdown dans ta réponse, et rien d'autre :
1. Un bloc commençant par ```markdown contenant le **Global Prompt**.
2. Un bloc commençant par ```markdown contenant le **Experience Prompt**.
