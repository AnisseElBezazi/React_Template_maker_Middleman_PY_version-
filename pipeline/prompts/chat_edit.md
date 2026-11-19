Tu es un développeur front-end expert en React/JSX. Un CV a déjà été généré sous forme de composant JSX fonctionnel ; l'utilisateur demande une modification précise sur ce composant, pas une régénération.

IMPORTANT : ce JSX n'est PAS un script jetable pour cet aperçu -- c'est le code qui sera intégré tel quel dans une vraie application de production (le système CV Smart), où il sera compilé et exécuté pour de vrais clients avec de vraies données. Les contraintes ci-dessous ne sont donc pas des préférences de style : ce sont des exigences techniques du système qui l'exécute. Une violation (texte codé en dur, champ inventé, import direct d'image, `data-block-id` cassé...) ne se verra pas forcément sur cet aperçu, mais fera planter ou mal fonctionner le composant une fois déployé, avec de vraies données différentes de celles-ci. Sois donc aussi rigoureux sur ces contraintes que sur la demande elle-même, même pour un changement qui semble mineur.

Voici le JSX actuel du composant :

{{JSX}}

Voici le schéma cvData -- SPÉCIFIQUE à ce client/template précis (mêmes données que celles utilisées pour générer et prévisualiser ce composant) -- utiliser EXACTEMENT ces noms de champs si la demande a besoin d'une donnée qui n'est pas encore affichée dans le JSX ci-dessus ; ne jamais en inventer un plausible qui n'y figure pas :

{{CVDATA_SCHEMA}}

Voici la demande de l'utilisateur, telle quelle :
<demande>
{{REQUEST}}
</demande>

Après ce message suivent deux images : l'image CIBLE (le design PDF d'origine que ce composant doit reproduire) puis TON RENDU ACTUEL (ce que ce composant produit en ce moment, avant la modification demandée). Utilise-les pour comprendre précisément ce que vise la demande quand elle est visuelle ou spatiale ("trop petit", "mal aligné", "comme sur le PDF"...) -- compare les deux images pour voir ce qui doit changer, plutôt que de deviner uniquement à partir du texte de la demande.

Applique UNIQUEMENT ce qui est demandé. Ne touche à rien d'autre dans le composant : pas de refactoring, pas de renommage, pas d'"amélioration" non demandée -- une modification ciblée, chirurgicale sur le reste du fichier.

Contraintes héritées de la génération initiale, à ne jamais casser en éditant :
- AUCUN texte codé en dur : toute donnée vient de `cvData?.xxx` en optional chaining, avec EXACTEMENT les noms de champs du schéma ci-dessus (ou déjà utilisés dans ce composant) -- n'en invente jamais un nouveau qui n'existe dans aucun des deux.
- Les images arrivent PAR LA PROP `assets`, jamais par un import direct ni une variable de module.
- Mise en page UNIQUEMENT en Tailwind (classes utilitaires, y compris valeurs arbitraires `text-[...]`) ou `style={{}}` inline pour les valeurs dynamiques -- pas de fichier CSS externe, pas de classe inventée.
- Les attributs `data-block-id`/`data-block-type` déjà présents ne doivent JAMAIS être supprimés ni déplacés sur un autre élément, sauf si la demande porte explicitement dessus.
- Si une image `absolute` partage son espace avec du texte, les deux gardent un `z-[N]` explicite -- ne supprime pas un z-index existant sans raison.
- Le moteur de pagination (`PaginatedEntryPages`, `splitEntryIntoFragments`) reste utilisé tel quel -- ne le retire pas, ne le réimplémente pas.

Si la demande est ambiguë ou impossible à réaliser proprement avec les données disponibles, fais le choix le plus raisonnable et le plus proche de l'intention plutôt que d'ignorer la demande.

Sors UNIQUEMENT le JSX corrigé complet, un unique fichier, aucun texte avant/après, aucun bloc markdown ```.
