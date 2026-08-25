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

1. AVANT toute correction, liste explicitement dans ta réponse (en pensée, ça ne sort pas dans le JSX) chaque écart que tu observes entre les 3 images et le dictionnaire : différences de marges, de largeurs de bloc, de tailles de police, de position (avec coordonnées approximatives tirées de la grille), de couleur. Il y a QUASI TOUJOURS au moins un écart de taille/position réel sur ce genre de reproduction -- pars du principe qu'il y en a et cherche-les activement plutôt que de conclure trop vite que c'est déjà correct. Si ton rendu paraît globalement plus petit/étroit que la cible (texte ET mise en page rétrécis proportionnellement), vérifie que le conteneur racine n'a pas de classe `max-w-*` -- ça doit être `w-full` / sans plafond, jamais `max-w-4xl` ou équivalent.
2. Corrige le JSX en conséquence pour CHAQUE écart listé à l'étape 1. Remplace toute couleur/taille approximative par la valeur exacte trouvée dans le dictionnaire HTML.
3. Si tu as approximé un logo/icône par du texte ou une forme parce qu'aucune image extraite ne correspondait (probablement un dessin vectoriel du PDF), NE LE LAISSE PAS EN L'ÉTAT : réserve-lui un `import xxx from '@/images/cv-templates/<nom-template>/extracted-N.png'` (nouvel index) et ajoute, après le JSX et hors bloc ```, une ligne EXTRA_IMAGES suivie du tableau JSON de sa zone en pixels dans l'image CIBLE (grille comprise, mêmes coordonnées) -- même format qu'en passe 1 :
EXTRA_IMAGES:[{"index": 10, "x": 1050, "y": 15, "width": 90, "height": 70}]
4. Respecte toujours les règles strictes de la passe 1 (pas de texte codé en dur, data-block-id partout, cvData?. partout, pas de `max-w-*` sur le conteneur racine).

Sors UNIQUEMENT le JSX corrigé complet, aucun texte avant/après, aucun bloc markdown (l'éventuelle ligne EXTRA_IMAGES vient après, hors bloc).
