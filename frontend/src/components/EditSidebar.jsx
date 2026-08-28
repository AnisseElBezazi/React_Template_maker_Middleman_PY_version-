import ScrubInput from "./ScrubInput";

const SIDES = [["n", "Haut"], ["e", "Droite"], ["s", "Bas"], ["w", "Gauche"]];

export default function EditSidebar({ editor, hasTarget, open }) {
  const { selection, spacingMode, setSpacingMode, setImageGeom, setSpacingSide,
          onionOn, onionOpacity, setOnionOpacity, pushOnion, status, pendingCount, saving, save, cancel } = editor;

  return (
    <aside id="editSidebar" className={open ? "open" : ""} aria-label="Ajuster les images">
      <h3>Ajuster</h3>
      <div>
        <p className="sb-label">Sélection</p>
        <div className="sb-box" id="sbSel">
          {!selection && <div className="sb-row"><span>Aucune</span></div>}
          {selection?.kind === "text" && (
            <>
              <div className="sb-row"><span>Texte</span><span>#{selection.id}</span></div>
              <div className="sb-row"><span>Contenu</span><span>{selection.label || "—"}</span></div>
              {selection.instances > 1 && (
                <div className="sb-row"><span>Instances</span><span>{selection.instances}</span></div>
              )}
            </>
          )}
          {selection?.kind === "img" && (
            <>
              <div className="sb-row"><span>Image</span><span>#{selection.id}</span></div>
              <ScrubInput label="Largeur" value={selection.width} min={0} onChange={(v) => setImageGeom("width", v)} />
              <ScrubInput label="Hauteur" value={selection.height} min={0} onChange={(v) => setImageGeom("height", v)} />
              <ScrubInput label="X" value={selection.left} onChange={(v) => setImageGeom("left", v)} />
              <ScrubInput label="Y" value={selection.top} onChange={(v) => setImageGeom("top", v)} />
            </>
          )}
        </div>
      </div>

      {hasTarget && (
        <div id="sbOnion" hidden={!onionOn}>
          <p className="sb-label">Calque de la cible</p>
          <div className="sb-box">
            <input type="range" id="onionOpacity" min="0" max="100" value={onionOpacity} aria-label="Opacité du calque"
              style={{ marginTop: 0 }}
              onChange={(e) => { const v = Number(e.target.value); setOnionOpacity(v); pushOnion(true, v, hasTarget); }} />
            <div className="sb-row"><span>Opacité</span><span id="onionVal">{onionOpacity} %</span></div>
          </div>
        </div>
      )}

      <div id="sbSpacing" hidden={selection?.kind !== "text"}>
        <p className="sb-label">Espacement</p>
        <div className="sb-box">
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            <button type="button" className={`sb-btn mode-btn${spacingMode === "padding" ? " active" : ""}`}
              onClick={() => setSpacingMode("padding")}>Intérieur (P)</button>
            <button type="button" className={`sb-btn mode-btn${spacingMode === "margin" ? " active" : ""}`}
              onClick={() => setSpacingMode("margin")}>Extérieur (M)</button>
          </div>
          {SIDES.map(([side, name]) => (
            <ScrubInput key={side} label={name} value={selection?.[side] ?? 0} onChange={(v) => setSpacingSide(side, v)} />
          ))}
        </div>
      </div>

      <div>
        <p className="sb-label">Raccourcis</p>
        <div className="sb-keys">
          <kbd>glisser</kbd> déplacer<br />
          <kbd>poignées</kbd> redimensionner<br />
          <kbd>Maj</kbd> + poignée : centre fixe<br />
          <kbd>←↑↓→</kbd> 1 px &nbsp; <kbd>Maj</kbd>+flèches 10 px<br />
          <kbd>P</kbd> marge intérieure &nbsp; <kbd>M</kbd> extérieure<br />
          <kbd>Ctrl</kbd>+<kbd>Z</kbd> annuler &nbsp; <kbd>Ctrl</kbd>+<kbd>Y</kbd> rétablir<br />
          <kbd>Échap</kbd> désélectionner
        </div>
      </div>

      <div className="sb-actions">
        <p className="sb-status" id="sbStatus">{status}</p>
        <button type="button" id="editSave" className="sb-btn primary" disabled={!pendingCount || saving} onClick={save}>
          {saving ? "Enregistrement..." : "Enregistrer"}
        </button>
        <button type="button" id="editCancel" className="sb-btn" onClick={() => cancel(hasTarget)}>Annuler et quitter</button>
      </div>
    </aside>
  );
}
