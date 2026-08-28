// Config utilisée UNIQUEMENT pour le CSS stocké en base (css_source).
//
// `important` en sélecteur préfixe chaque règle en `.cv-smart-scope .foo`,
// ce qui empêche le CSS du template de fuir sur le reste de l'app -- c'est
// ce qui avait cassé la sidebar en production : un `.hidden{display:none}`
// non scopé s'appliquait à toute la page.
//
// `preflight: false` retire le reset global. Le fichier d'entrée ne contient
// déjà que `@tailwind utilities`, donc le reset ne serait pas émis de toute
// façon : c'est une double sécurité si quelqu'un modifie l'entrée.
//
// `content` est fourni par --content à l'appel, il change à chaque template.
module.exports = {
  content: [],
  important: '.cv-smart-scope',
  corePlugins: { preflight: false },
}
