// Les étapes de la pipeline et leur rendu dans le suivi de run.

/** Les étapes réelles émises par runPipeline, dans l'ordre. Elles servent de
 * fil conducteur à l'écran de suivi : "extract" puis 3 tentatives Claude puis
 * 2 correctifs de taille. `render` est un sous-message d'une passe et `done`
 * la fin -- ni l'un ni l'autre n'est une étape à part entière. */
export const STAGES = [
  { id: "extract", name: "Extraction", note: "Capture de la page cible et dictionnaire HTML" },
  { id: "pass1", name: "Passe 1", note: "Premier jet du composant" },
  { id: "pass2", name: "Passe 2", note: "Correction guidée par le diff visuel" },
  { id: "pass3", name: "Passe 3", note: "Audit du rendu" },
  { id: "scale-fix", name: "Passe 4", note: "Recalage de l'échelle globale" },
  { id: "size-fix", name: "Passe 5", note: "Ajustement taille par élément" },
];

export const JINJA_STAGES = [
  { id: "extract", name: "Extraction", note: "Extraction du texte du CV" },
  { id: "pass1", name: "Passe 1", note: "Mapping Jinja (Remplacements)" },
  { id: "pass2", name: "Passe 2", note: "Configuration (Extra Config)" },
  { id: "pass3", name: "Passe 3", note: "Prompts d'extraction" },
  { id: "render", name: "Génération", note: "Génération du .docx" },
];

/** Rail d'étapes : les passes franchies, celle en cours, celles à venir.
 * Un simple libellé "Étape : pass2" ne dit pas où on en est dans la
 * séquence -- ici la position dans la liste porte l'information. */
export function renderStages(currentStep, message, type = "jsx") {
  const stages = type === "jinja" ? JINJA_STAGES : STAGES;
  const known = stages.findIndex((s) => s.id === currentStep);
  // "render" et les avertissements arrivent pendant une passe : on reste sur
  // la dernière étape connue plutôt que de retomber à zéro.
  const idx = currentStep === "done" ? stages.length : (known === -1 ? 0 : known);
  return `<ol class="stages">
    ${stages.map((s, i) => {
      const state = i < idx ? "past" : i === idx ? "now" : "";
      const note = state === "now" && message ? message : s.note;
      return `<li class="stage ${state}">
        <div class="stage-mark"><span class="stage-dot">${i < idx ? "✓" : i + 1}</span></div>
        <div class="stage-body">
          <div class="stage-name">${s.name}</div>
          <div class="stage-note">${note}</div>
        </div>
      </li>`;
    }).join("")}
  </ol>`;
}
