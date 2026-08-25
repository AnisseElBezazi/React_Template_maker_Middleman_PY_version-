Tu vas maintenant comparer TON PROPRE rendu à l'image CIBLE et t'auto-corriger. Tu reçois 3 images, dans cet ordre, TOUTES avec une grille de repères magenta superposée (graduée tous les 50px, origine en haut à gauche) pour que tu puisses raisonner en COORDONNÉES plutôt qu'à l'oeil :

1. Image CIBLE (avec grille)
2. TON RENDU ACTUEL (avec grille)
3. Image de DIFFÉRENCE (pixelmatch) : tout ce qui est identique entre les deux apparaît en gris/estompé, tout ce qui DIFFÈRE apparaît en ROUGE VIF. C'est la carte de tes erreurs -- une zone rouge = un écart réel à corriger.
   ATTENTION : l'image CIBLE est le PDF Jinja NON REMPLI (texte brut `{{ ... }}`), alors que ton rendu affiche du vrai texte d'exemple -- le contenu textuel ne peut donc JAMAIS matcher pixel pour pixel, et une grande partie du rouge vient normalement de ça (texte différent, largeurs de ligne différentes en conséquence). NE CORRIGE PAS pour faire matcher le texte littéral. En revanche, une zone rouge qui correspond à un DÉCALAGE DE BLOC ENTIER (logo mal placé/mal dimensionné, section dupliquée, marge/espacement clairement différent, alignement décalé de plusieurs dizaines de pixels) est un vrai bug -- utilise les coordonnées de la grille sur les 3 images pour vérifier précisément où ton rendu s'arrête vs où la cible s'arrête (ex: "mon bloc Certifications va de x=290 à x=690, la cible montre un bandeau qui va jusqu'à x=1115 -- ma largeur est fausse").

Voici le JSX que tu as généré :

{{JSX}}

Voici le dictionnaire de style extrait du PDF source (une ligne par texte, format `x,y|taille|couleur|texte` -- x,y = position exacte en pixels dans l'image cible, couleurs hex exactes, tailles de police exactes, texte précis -- utilise-le pour remplacer toute approximation de couleur/taille ET pour vérifier l'alignement/l'ordre relatif des éléments) :

{{DICTIONARY}}

Instructions -- fais les étapes DANS CET ORDRE, n'improvise pas un résumé positif à la place :

0. OBJECTIF : le rendu doit être VISUELLEMENT IDENTIQUE à la cible, pas seulement « ressemblant ». Tant qu'un bloc n'est pas au même endroit, à la même taille et de la même couleur que sur la cible, le travail n'est pas fini.
   Commence par les écarts de STRUCTURE, ce sont eux qui sautent aux yeux et ce sont ceux qu'on oublie le plus souvent :
   - position et taille de CHAQUE bloc (bandeaux, en-tête, colonnes, encadrés, pieds de page) : compare leurs coordonnées sur la grille, pas leur allure générale ;
   - position et taille de CHAQUE image (logo, filigrane, décor) : un logo décalé de 50 px ou deux fois trop petit est un écart majeur, pas un détail ;
   - largeur des colonnes, points de rupture entre elles, ordre vertical des sections ;
   - marges extérieures de la page et espacements entre sections.
   Ce n'est qu'APRÈS avoir traité ces écarts-là que tu passes aux couleurs et aux tailles de police.
   NE T'ARRÊTE PAS après deux ou trois corrections mineures : parcours la page de haut en bas, bloc par bloc, et corrige TOUT ce qui diffère. Une passe qui ne change que des tailles de texte est une passe ratée.

1. AVANT toute correction, liste explicitement dans ta réponse (en pensée, ça ne sort pas dans le JSX) chaque écart que tu observes entre les 3 images et le dictionnaire : différences de marges, de largeurs de bloc, de tailles de police, de position (avec coordonnées approximatives tirées de la grille), de couleur. Vérifie SPÉCIALEMENT si tu n'as pas empilé verticalement des sections qui sont censées être côte à côte en colonnes (vérifie si des blocs ont des X différents mais des Y similaires sur la cible). Il y a QUASI TOUJOURS au moins un écart de taille/position réel sur ce genre de reproduction -- pars du principe qu'il y en a et cherche-les activement plutôt que de conclure trop vite que c'est déjà correct. Si ton rendu paraît globalement plus petit/étroit que la cible (texte ET mise en page rétrécis proportionnellement), vérifie que le conteneur racine n'a pas de classe `max-w-*` -- ça doit être `w-full` / sans plafond, jamais `max-w-4xl` ou équivalent.
2. Corrige le JSX en conséquence pour CHAQUE écart listé à l'étape 1. Remplace toute couleur/taille approximative par la valeur exacte trouvée dans le dictionnaire HTML. Vérifie attentivement les couleurs de fond (les rectangles colorés sous le texte) : si tu n'as pas réussi à trouver la couleur exacte, découpe ce fond via `EXTRA_IMAGES`.
3. Si tu as tenté de dessiner une forme vectorielle (cercle, ligne, icône, géométrie complexe) en CSS pur (ce qui est FORMELLEMENT INTERDIT), NE LE LAISSE PAS EN L'ÉTAT : réserve-lui un `import xxx from '@/images/cv-templates/<nom-template>/extracted-N.png'` (nouvel index) et ajoute, après le JSX et hors bloc ```, une ligne EXTRA_IMAGES suivie du tableau JSON de sa zone en pixels dans l'image CIBLE (grille comprise, mêmes coordonnées) -- même format qu'en passe 1 :
EXTRA_IMAGES:[{"index": 10, "x": 1050, "y": 15, "width": 90, "height": 70}]
4. Respecte toujours les règles strictes de la passe 1 (pas de texte codé en dur, data-block-id partout, cvData?. partout, pas de `max-w-*` sur le conteneur racine).

- RAPPEL VITAL AVANT DE GÉNÉRER :
  1. As-tu laissé un cercle, une ligne, ou une forme dessinée en CSS ? SI OUI, ARRÊTE IMMÉDIATEMENT. Retire le CSS et demande une découpe via `EXTRA_IMAGES`.
  2. As-tu laissé une couleur de fond approximative ? SI OUI, ARRÊTE. Demande une découpe via `EXTRA_IMAGES` ou mets le code hex exact.
  3. As-tu utilisé `backgroundImage` SANS `bg-cover bg-no-repeat` en Tailwind ? SI OUI, ajoute ces classes !
  4. As-tu laissé un `import './monTemplate.css'` ou une fausse classe non-Tailwind ? SI OUI, supprime-les et remplace par des classes Tailwind.

Sors UNIQUEMENT le JSX corrigé complet, aucun texte avant/après, aucun bloc markdown (l'éventuelle ligne EXTRA_IMAGES vient après, hors bloc).
