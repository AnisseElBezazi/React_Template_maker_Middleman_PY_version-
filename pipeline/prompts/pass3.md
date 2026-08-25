Audit final de sécurité et de câblage sur ce composant JSX -- pas de changement visuel, uniquement structurel :

{{JSX}}

Vérifie et corrige si besoin :

1. Absence totale de texte codé en dur : TOUTE donnée affichée doit provenir de `cvData` via optional chaining (?.), avec un fallback raisonnable ("" ou null).
2. Chaque bloc visuel (section, sous-bloc répété comme une expérience ou une compétence) porte bien `data-block-type` et un `data-block-id` unique et stable.
3. Le composant reste un unique `export default function <Nom>TemplateHtml({ cvData })` (le même nom déjà choisi dans les passes précédentes -- ne le renomme pas en `CvPage` ni autre chose).
4. Pas de clé React manquante si une liste est mappée (cvData?.experiences?.map(...)) -- utilise un id stable de la donnée si possible, sinon l'index en dernier recours.
5. Le conteneur racine n'a pas de classe Tailwind `max-w-*` (doit rester `w-full`, sans plafond de largeur).

Sors UNIQUEMENT le JSX final corrigé, aucun texte avant/après, aucun bloc markdown.
