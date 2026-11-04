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

Voici la liste des remplacements Jinja qui viennent d'être effectués sur ce document à l'étape précédente. **Examine attentivement cette liste pour repérer les balises `data.xxx` dont `xxx` ne correspond à AUCUN champ du schéma de base ci-dessus** (ex: `data.loisirs`) -- ce sont des champs inventés parce qu'ils ne figuraient pas dans le schéma standard :
<replacements-effectues>
{REPLACEMENTS}
</replacements-effectues>

**Mission :**
Génère le JSON `extra_config` pour ce nouveau CV.
- Conserve la structure de l'exemple.
- **CRUCIAL : Assure-toi d'intégrer et de configurer tous les champs `data.xxx` inédits (absents du schéma de base) qui auraient été inventés dans la section `<replacements-effectues>`.**
- Adapte les libellés (`display_name`) ou les champs si le CV cible possède des sections différentes ou supplémentaires.
- **RETIRE toute section de l'exemple qui ne correspond à AUCUNE balise `data.xxx` présente dans `<replacements-effectues>`.** L'exemple montre une structure COMPLÈTE (`certifications`, `personal_projects`, `experiences_summary`...) mais un CV/gabarit cible n'utilise pas forcément toutes ces sections -- une section absente du gabarit qui reste quand même dans `extra_config` ne sert à rien et complique la maintenance. Vérifie chaque section de l'exemple une par une : si son `data_name` n'apparaît dans AUCUN remplacement de `<replacements-effectues>`, ne la recopie pas.
- **Cette même vérification s'applique aussi À L'INTÉRIEUR d'une section standard toujours présente (ex: `experiences`), pas seulement aux sections entières.** Une section utilisée dans son ensemble peut quand même contenir un sous-champ imbriqué inutile -- confirmé sur un cas réel : `experiences[].projects` (une liste de projets distincts imbriquée dans chaque expérience) ne correspondait à aucune balise du gabarit cible (qui n'affiche qu'un seul bloc de texte par expérience, jamais plusieurs projets nommés séparément), et Middleman ne permet de toute façon pas de saisir plusieurs projets distincts au sein d'une même expérience -- ce sous-champ était donc mort dès sa génération, quelle que soit la structure du CV modèle. Repère spécifiquement les sous-champs qui répètent en interne la structure d'une AUTRE section (une liste d'objets nommés à l'intérieur d'un item déjà lui-même dans une liste) : c'est le signal qu'un sous-niveau a été recopié par habitude plutôt que parce que le gabarit cible en a besoin.
- Renvoie UNIQUEMENT un bloc de code JSON commençant par ```json. Ne mets aucun texte avant ou après.

- RAPPEL VITAL AVANT DE GÉNÉRER :
  1. As-tu repéré TOUTES les balises `data.xxx` de `<replacements-effectues>` dont `xxx` n'existe PAS dans le schéma de base -- pas juste la première que tu as vue ? Passe vraiment la liste en revue en entier.
  2. Chacun de ces champs inventés a-t-il bien sa propre entrée complète dans `extra_config` (`data_name`, `display_name`, et le reste de la structure attendue) ? SI L'UN D'EUX MANQUE, ajoute-le -- un champ absent d'ici finit mal configuré côté interface, même si son remplacement Jinja est correct.
  3. As-tu cherché un `xxx` qui ressemble à un champ standard (variante de nom proche) avant de le classer comme inventé ? Une ressemblance de nom ne suffit pas à l'écarter à tort.
  4. As-tu recopié une section de l'exemple par habitude (`certifications`, `personal_projects`, `experiences_summary`...) alors qu'AUCUN remplacement de `<replacements-effectues>` ne l'utilise ? SI OUI, retire-la -- une section absente du gabarit cible n'a rien à faire dans `extra_config`.
  5. Pour CHAQUE section conservée (même utilisée), as-tu vérifié un par un ses sous-champs imbriqués (listes d'objets à l'intérieur d'un item) contre `<replacements-effectues>` ? Une section globalement utilisée peut quand même contenir un sous-champ que le gabarit cible n'affiche jamais -- ne le garde pas juste parce que le reste de la section sert.
