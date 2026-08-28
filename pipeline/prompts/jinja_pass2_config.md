Tu es un expert technique spécialisé dans la configuration d'applications.

Le système de base extrait toujours les informations d'un CV vers un schéma JSON standard. 
Voici la structure exacte de ce schéma de base (données standard extraites pour chaque candidat) :
<schema-de-base>
{SAMPLE_CVDATA}
</schema-de-base>

L'objectif de cette étape est de générer UNIQUEMENT la configuration "Extra" (`extra_config.json`). Cette configuration sert à définir les mappings spécifiques vers le CRM (ex: BoondManager) et à configurer l'interface Front-End pour les champs qui pourraient être spécifiques au modèle de CV fourni.

Voici un exemple d'`extra_config` valide :
<exemple-config>
{EXAMPLE_CONFIG}
</exemple-config>

Voici le texte extrait du modèle de CV cible :
<cv-text>
{CV_TEXT}
</cv-text>

Voici la liste des remplacements Jinja qui viennent d'être effectués sur ce document à l'étape précédente. **Examine attentivement cette liste pour repérer si de nouvelles balises Jinja (ex: `custom.quelquechose`) ont été inventées** parce qu'elles ne figuraient pas dans le schéma de base :
<replacements-effectues>
{REPLACEMENTS}
</replacements-effectues>

**Mission :**
Génère le JSON `extra_config` pour ce nouveau CV.
- Conserve la structure de l'exemple.
- **CRUCIAL : Assure-toi d'intégrer et de configurer toutes les balises inédites/custom qui auraient été inventées dans la section `<replacements-effectues>`.**
- Adapte les libellés (`display_name`) ou les champs si le CV cible possède des sections différentes ou supplémentaires.
- Renvoie UNIQUEMENT un bloc de code JSON commençant par ```json. Ne mets aucun texte avant ou après.
