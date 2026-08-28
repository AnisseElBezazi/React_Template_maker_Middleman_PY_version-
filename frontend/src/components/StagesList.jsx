// Memes etapes, dans le meme ordre, que cote backend (stages_view.mjs
// d'origine) -- "render" et les avertissements arrivent PENDANT une passe,
// on reste donc sur la derniere etape connue plutot que de retomber a zero.
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

export function stageIndex(step, stages = STAGES) {
  const known = stages.findIndex((s) => s.id === step);
  return step === "done" ? stages.length : known === -1 ? 0 : known;
}

/** Rail d'etapes : les passes franchies, celle en cours, celles a venir. La
 * position dans la liste porte l'information, pas juste le libelle courant. */
export default function StagesList({ currentStep, message, type = "jsx" }) {
  const stages = type === "jinja" ? JINJA_STAGES : STAGES;
  const idx = stageIndex(currentStep, stages);
  return (
    <ol className="stages">
      {stages.map((s, i) => {
        const state = i < idx ? "past" : i === idx ? "now" : "";
        const note = state === "now" && message ? message : s.note;
        return (
          <li key={s.id} className={`stage ${state}`}>
            <div className="stage-mark"><span className="stage-dot">{i < idx ? "✓" : i + 1}</span></div>
            <div className="stage-body">
              <div className="stage-name">{s.name}</div>
              <div className="stage-note">{note}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
