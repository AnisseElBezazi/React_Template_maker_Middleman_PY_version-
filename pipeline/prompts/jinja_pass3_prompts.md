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

**Nettoyage symétrique -- retire ce que `<extra-config>` n'utilise pas :** les exemples de référence couvrent une structure COMPLÈTE (`certifications`, `personal_projects`, `experiences_summary`...), mais `<extra-config>` peut ne pas toutes les utiliser. Pour CHAQUE section présente dans les exemples de référence mais ABSENTE de `<extra-config>` (aucun `data_name` correspondant), ne la fais apparaître NULLE PART dans les 2 prompts que tu rédiges -- ni comme section dédiée avec ses règles, ni dans le JSON final de sortie. Ne recopie jamais une section d'exemple par habitude ou par souci de "ressembler à l'exemple" : le prompt final doit correspondre exactement à ce que `<extra-config>` utilise, rien de plus.

**Ce nettoyage vaut aussi À L'INTÉRIEUR d'une section conservée, pas seulement entre sections.** Une section standard toujours présente (ex: `experiences`) peut, dans les exemples de référence, contenir un sous-champ imbriqué (une liste d'objets nichée à l'intérieur d'un item déjà lui-même dans une liste) qui ne correspond à rien dans `<extra-config>` pour CE gabarit précis -- retire ce sous-champ des instructions ET du JSON de sortie, même si le reste de la section est légitimement conservé. Cas réel : un exemple de référence modélisait plusieurs projets distincts nichés dans chaque expérience (`experiences[].projects`), alors que le gabarit cible n'affiche qu'un seul bloc de texte par expérience -- ce sous-champ ne devait apparaître nulle part dans le prompt généré, y compris quand `experiences` elle-même est bien utilisée.

**Champs INVENTÉS (présents dans `<extra-config>` mais absents des exemples de référence) :** le CV cible peut avoir des sections qui n'existent dans AUCUN des deux exemples -- reconnaissables dans `<extra-config>` par un `data_name` qui n'y apparaît jamais. Pour CHAQUE champ de `<extra-config>`, standard ou inventé, le prompt final doit contenir une vraie section d'INSTRUCTIONS D'EXTRACTION (quoi y mettre, d'où le tirer dans le CV) -- pas seulement une entrée dans le JSON de sortie à la fin. Un champ qui n'apparaît QUE dans ce JSON final, sans instructions dédiées, finit systématiquement vide ou incohérent une fois utilisé en extraction réelle -- confirmé sur un cas réel : `technical_skills` et `functional_skills` n'avaient droit qu'à une ligne dans le JSON final, aucune instruction nulle part ailleurs, et le CV généré a fini avec CHAQUE catégorie de compétence présente mais VIDE (juste des virgules, aucun mot-clé). **Avant de rendre ta réponse, fais explicitement la liste de TOUS les `data_name` présents dans `<extra-config>` un par un, et pour CHACUN vérifie que le prompt contient bien un paragraphe d'instructions dédié qui lui correspond** -- ne te fie pas à une impression générale de complétude, énumère vraiment. Ceci s'applique MÊME si le champ ressemble à un champ standard ou à un champ déjà vu dans les exemples : une ressemblance de nom ne veut pas dire que les instructions des exemples s'appliquent telles quelles, ni qu'elles couvrent ce champ précis -- et même si le CV cible a un champ qui, dans un CV bien rempli, est presque toujours renseigné (ex: une liste de compétences clés) : explique-le avec autant de soin que les champs standard, pas comme une note secondaire.

**Pour CHAQUE champ (standard ou inventé), distingue une information QUASI-UNIVERSELLE d'une information GENUINEMENT OPTIONNELLE avant d'écrire la règle de repli "vide si absent" -- ce n'est pas spécifique à un champ en particulier, c'est une question à te poser systématiquement.** Une info quasi-universelle est le genre de chose qu'un CV réel contient PRESQUE TOUJOURS sous une forme ou une autre -- même diffuse dans le texte général, pas forcément isolée sous un intitulé dédié (ex: l'environnement technique ou le secteur métier d'une expérience, les compétences clés d'une personne). Une info genuinement optionnelle est celle que beaucoup de candidats n'ont simplement pas (ex: loisirs, publications, distinctions). Pour la PREMIÈRE catégorie, n'écris JAMAIS une instruction qui exige une rubrique dédiée explicitement labellisée comme SEULE source valide, ni une interdiction du type "ne jamais déduire" -- demande de privilégier une rubrique dédiée si elle existe, SINON de déduire raisonnablement depuis le contexte général (la description, les missions...). Réserve "vide/[] si absent" à la DEUXIÈME catégorie, ou à un manque réel d'information même en cherchant dans tout le texte.

Confirmé sur un cas réel avec `technical_environment`/`business_environment` : l'exemple de référence dit simplement "Reprendre uniquement les technologies présentes dans le CV", mais le prompt généré avait durci ça en "reprendre UNIQUEMENT sous un libellé « Environnement technique »... si absent → ''" et "Ne jamais déduire" pour l'équivalent métier -- résultat, un candidat qui rédige ses missions en prose (technologies citées dans le texte des puces plutôt que sous une rubrique séparée) s'est retrouvé avec ces DEUX champs vides, alors que l'info était bien présente dans le CV, juste pas sous la forme rigide exigée. Le prochain champ à souffrir du même excès de rigueur ne s'appellera pas forcément pareil -- c'est le PRINCIPE ci-dessus qu'il faut appliquer, pas seulement ce nom de champ précis.

**Forme d'un champ inventé -- valeur/liste simple vs liste d'objets `{type, text}` :** le patron `{"type": "paragraph"|"list"|..., "text": "..."}` (voir `description`/`tasks`/`results` dans les exemples) sert UNIQUEMENT à du contenu affichable sur PLUSIEURS LIGNES avec une mise en forme variable (paragraphe, puce, sous-puce...). Ne l'applique PAS par réflexe à un champ inventé qui est en réalité une simple liste de MOTS-CLÉS COURTS (tags/étiquettes, compétences en un ou deux mots) -- un tel champ reste une liste de chaînes de caractères ordinaires (`["Fullstack", "TypeScript", "React.js"]`), jamais une liste d'objets `{type, text}` : le gabarit Word qui l'affiche attend directement le texte du mot-clé, pas un objet structuré, et reçoit sinon la représentation brute de l'objet entier. Distingue les deux cas par la NATURE du contenu dans le CV cible (mots/expressions courts et isolés → liste de chaînes simples ; phrases/puces à mise en forme variable → liste d'objets `{type, text}`), jamais par habitude ou parce qu'un AUTRE champ du même CV utilise ce patron.

- RAPPEL VITAL AVANT DE RÉPONDRE :
  1. As-tu listé, un par un, TOUS les `data_name` de `<extra-config>` et vérifié que CHACUN a un vrai paragraphe d'instructions d'extraction dans le prompt -- pas seulement une entrée dans le JSON final ? SI L'UN D'EUX N'EN A PAS, ajoute-le, MÊME s'il ressemble à un champ standard ou presque toujours rempli (ex: compétences clés).
  2. Pour chaque champ inventé, as-tu vérifié dans le CV cible si son contenu est une liste de MOTS-CLÉS COURTS (→ liste de chaînes simples) ou du texte multi-lignes à mise en forme variable (→ liste d'objets `{type, text}`) ? SI TU AS COPIÉ le patron d'un AUTRE champ du même CV par habitude sans revérifier CELUI-LÀ, corrige.
  3. As-tu changé le fond des règles d'extraction (intégrité des données, gestion des dates, correction orthographique...) par rapport aux exemples de référence ? SI OUI, reviens en arrière -- seules les règles propres aux champs spécifiques à CE CV cible doivent varier.
  5. As-tu recopié une section des exemples de référence (`certifications`, `personal_projects`, `experiences_summary`...) alors qu'AUCUN `data_name` correspondant n'existe dans `<extra-config>` ? SI OUI, retire-la des 2 prompts -- section dédiée ET entrée dans le JSON final.
  4. Repasse TOUS les champs (pas juste `technical_environment`/`business_environment`) : pour chacun, as-tu exigé une rubrique dédiée explicitement labellisée ou interdit toute déduction ("ne jamais déduire"), alors que c'est le genre d'info qu'un CV réel contient presque toujours (même diffuse dans le texte) ? SI OUI, retire cette restriction pour CE champ -- ne réserve "vide si absent" qu'aux informations génuinement optionnelles.
  6. Pour CHAQUE section standard conservée (`experiences`...), as-tu vérifié ses sous-champs imbriqués un par un contre `<extra-config>` -- pas seulement décidé de garder ou retirer la section entière ? Un sous-champ niché (liste d'objets à l'intérieur d'un item déjà dans une liste) sans `data_name` correspondant doit disparaître du prompt même si le reste de la section sert.

Tu dois renvoyer EXACTEMENT 2 blocs de code Markdown dans ta réponse, et rien d'autre :
1. Un bloc commençant par ```markdown contenant le **Global Prompt**.
2. Un bloc commençant par ```markdown contenant le **Experience Prompt**.
