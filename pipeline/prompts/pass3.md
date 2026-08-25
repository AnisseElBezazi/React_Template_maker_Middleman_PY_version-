Audit de câblage sur ce composant JSX -- aucun changement visuel, uniquement structurel :

{{JSX}}

Un contrôle automatique a déjà été passé sur ce fichier et a relevé les points ci-dessous. Corrige-les, ce sont des faits vérifiés, pas des suppositions :

{{FINDINGS}}

Vérifie aussi ces points, que le contrôle automatique ne sait pas juger :

1. Absence de texte codé en dur : toute donnée affichée vient de `cvData` en optional chaining, avec un repli raisonnable ("" ou null). Les libellés de section ("Certifications", "Langues"...) ne sont pas des données : ils restent en dur.
2. Chaque bloc visuel porte un `data-block-type` cohérent avec sa nature.
3. Le composant reste un unique `export default function <Nom>TemplateHtml({ cvData })` -- garde le nom déjà choisi, ne le renomme pas.
4. Pas de clé React manquante sur une liste mappée : privilégie un identifiant stable de la donnée, l'index en dernier recours.

Sors UNIQUEMENT le JSX final corrigé, aucun texte avant/après, aucun bloc markdown.
