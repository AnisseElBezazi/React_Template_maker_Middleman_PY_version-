import { useRef, useState } from "react";
import Toolbar from "../components/Toolbar";
import RunsRail from "../components/RunsRail";
import PipelineNav from "../components/PipelineNav";
import { IconFile, IconPlay } from "../components/Icons";
import { useRuns } from "../hooks/useRuns";
import { createJinjaRun } from "../api/jinja_api";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function JinjaPage() {
  useDocumentTitle("CV ➔ Docx (Jinja)");
  const runs = useRuns();
  const [cv, setCv] = useState(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [effort, setEffort] = useState("high");
  const inputRef = useRef(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!cv) return;
    setBusy(true);
    setError(null);
    try {
      const { run_id } = await createJinjaRun(cv, effort);
      window.location.href = `/runs/${run_id}`;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar crumb={<span className="cur">Nouveau run Jinja</span>} />
      <div className="workbench">
        <aside className="rail"><RunsRail runs={runs} /></aside>
        <main className="canvas"><div className="canvas-pad canvas-center">
          <PipelineNav active="jinja" />
          <form id="jinjaForm" className="sheet" onSubmit={handleSubmit}>
            <div className="sheet-head">
              <div>
                <h2>Remplissage Jinja</h2>
                <p>Un CV entre, un Docx rempli en sort (via Kimi K3).</p>
              </div>
            </div>

            <div className="sheet-body">
              <p className="sec"><span className="step-n">1</span>Document CV (.docx)</p>
              <div id="dropzone" className={`${cv ? "has-file" : ""} ${drag ? "drag" : ""}`.trim()}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDrag(false);
                  if (e.dataTransfer.files.length) setCv(e.dataTransfer.files[0]);
                }}>
                <div className="dz-inner">
                  <span className="dz-icon"><IconFile /></span>
                  <div>
                    <p className="big">{cv ? cv.name : "Glisse un .docx ici"}</p>
                    <p className="sub">{cv ? `${(cv.size / 1024 / 1024).toFixed(2)} Mo — prêt` : "ou clique pour en choisir un"}</p>
                  </div>
                </div>
                <input type="file" accept=".docx" id="cvInput" ref={inputRef} hidden required
                  onChange={(e) => { if (e.target.files.length) setCv(e.target.files[0]); }} />
              </div>
              <p className="hint" style={{ marginTop: 16 }}>
                Fournissez un CV au format .docx rempli avec des données factices. Le système générera le
                template Jinja correspondant, les 2 prompts et l'extra-config.
              </p>

              <div className="field-row" style={{ marginTop: 16 }}>
                <label htmlFor="effortInput">Raisonnement
                  <span className="hint">S'applique aux 3 passes. Plus haut = meilleure analyse, mais le raisonnement est facturé comme de la sortie.</span>
                </label>
                <select className="num" id="effortInput" value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="low">low — rapide</option>
                  <option value="high">high — par défaut</option>
                  <option value="max">max — template complexe</option>
                </select>
              </div>
            </div>

            {error && <p className="error-msg">{error}</p>}
            <div className="sheet-foot">
              <button type="submit" id="submitJinjaBtn" className="btn primary" disabled={!cv || busy}>
                <IconPlay /><span className="btn-label">{busy ? "Démarrage..." : "Lancer la génération"}</span>
              </button>
            </div>
          </form>
        </div></main>
      </div>
    </>
  );
}
