import { useRef, useState } from "react";
import Toolbar from "../components/Toolbar";
import RunsRail from "../components/RunsRail";
import { IconFile, IconPlay } from "../components/Icons";
import { useRuns } from "../hooks/useRuns";
import { createRun } from "../api/runs_api";
import PipelineNav from "../components/PipelineNav";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function HomePage() {
  useDocumentTitle("Pipeline Design-to-Code");
  const runs = useRuns();
  const [pdf, setPdf] = useState(null);
  const [page, setPage] = useState("all");
  const [effort, setEffort] = useState("high");
  const [hasCoverPage, setHasCoverPage] = useState(false);
  const [pdfDrag, setPdfDrag] = useState(false);

  const [ecTab, setEcTab] = useState("file");
  const [ecFile, setEcFile] = useState(null);
  const [ecDrag, setEcDrag] = useState(false);
  const [ecText, setEcText] = useState("");
  const [ecStatus, setEcStatus] = useState({ text: "", kind: "" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fileInputRef = useRef(null);
  const ecInputRef = useRef(null);
  const ecTextRef = useRef(null);

  function validateEcText(val) {
    const trimmed = val.trim();
    if (!trimmed) { setEcStatus({ text: "", kind: "" }); return true; }
    try {
      JSON.parse(trimmed);
      setEcStatus({ text: "JSON valide", kind: "ok" });
      return true;
    } catch (err) {
      setEcStatus({ text: `JSON invalide : ${err.message}`, kind: "err" });
      return false;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!pdf) return;
    const trimmed = ecText.trim();
    if (trimmed && !validateEcText(trimmed)) {
      setEcTab("paste");
      ecTextRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { run_id } = await createRun({
        pdf, page, effort, hasCoverPage,
        extraConfigFile: ecTab === "file" ? ecFile : null,
        extraConfigText: ecTab === "paste" ? trimmed : null,
      });
      window.location.href = `/runs/${run_id}`;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const pdfLabel = pdf ? pdf.name : "Glisse un PDF ici";
  const pdfSub = pdf ? `${(pdf.size / 1024 / 1024).toFixed(2)} Mo — prêt` : "ou clique pour en choisir un";
  const submitLabel = busy ? "Démarrage..." : pdf ? "Lancer la génération" : "Choisis d'abord un PDF";

  return (
    <>
      <Toolbar crumb={<span className="cur">Nouveau run</span>} />
      <div className="workbench">
        <aside className="rail"><RunsRail runs={runs} /></aside>
        <main className="canvas"><div className="canvas-pad canvas-center">
          <PipelineNav active="pdf" />
          <form id="uploadForm" className="sheet" onSubmit={handleSubmit}>
            <div className="sheet-head">
              <div>
                <h2>Nouveau run</h2>
                <p>Un PDF entre, un composant React en sort. 5 passes : extraction, 3 tentatives, correctifs de taille.</p>
              </div>
            </div>

            <div className="sheet-body">
              <p className="sec"><span className="step-n">1</span>PDF source</p>
              <div id="dropzone" className={`${pdf ? "has-file" : ""} ${pdfDrag ? "drag" : ""}`.trim()}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setPdfDrag(true); }}
                onDragLeave={() => setPdfDrag(false)}
                onDrop={(e) => {
                  e.preventDefault(); setPdfDrag(false);
                  if (e.dataTransfer.files.length) setPdf(e.dataTransfer.files[0]);
                }}>
                <div className="dz-inner">
                  <span className="dz-icon"><IconFile /></span>
                  <div>
                    <p className="big">{pdfLabel}</p>
                    <p className="sub">{pdfSub}</p>
                  </div>
                </div>
                <input type="file" accept="application/pdf" id="fileInput" ref={fileInputRef} hidden
                  onChange={(e) => { if (e.target.files.length) setPdf(e.target.files[0]); }} />
              </div>

              <div className="field-row">
                <label htmlFor="pageInput">Page à traiter
                  <span className="hint">« all » pour tout le template, ou un numéro pour n'en faire qu'une.</span>
                </label>
                <input type="text" className="num" id="pageInput" value={page} pattern="[0-9]+|all|ALL"
                  title="Un numéro de page, ou all" onChange={(e) => setPage(e.target.value)} />
              </div>

              <div className="field-row">
                <label htmlFor="effortInput">Raisonnement de la passe 1
                  <span className="hint">Plus haut = meilleure analyse, mais le raisonnement est facturé comme de la sortie.</span>
                </label>
                <select className="num" id="effortInput" value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="low">low — rapide</option>
                  <option value="high">high — par défaut</option>
                  <option value="max">max — template complexe</option>
                </select>
              </div>

              <div className="field-row">
                <label htmlFor="coverPageInput">Page de couverture
                  <span className="hint">Coche si la page 1 a un habillage à part (fond/logo différent) des pages suivantes — évite au modèle de se tromper quand il doit le deviner lui-même.</span>
                </label>
                <input type="checkbox" id="coverPageInput" checked={hasCoverPage}
                  onChange={(e) => setHasCoverPage(e.target.checked)} />
              </div>
            </div>

            <div className="sheet-head" style={{ borderTop: "1px solid var(--sheet-rule)", borderBottom: "none", alignItems: "center" }}>
              <div>
                <h2><span className="step-n">2</span>extra_config<span style={{ fontWeight: 400, color: "var(--sheet-tx-3)" }}> — optionnel</span></h2>
                <p>Schéma réel du template (CvParserConfig). Sans lui, un schéma générique est utilisé.</p>
              </div>
              <div className="tabs">
                <button type="button" className={`tab-btn${ecTab === "file" ? " active" : ""}`} onClick={() => setEcTab("file")}>Fichier</button>
                <button type="button" className={`tab-btn${ecTab === "paste" ? " active" : ""}`} onClick={() => setEcTab("paste")}>Coller</button>
              </div>
            </div>
            <div className="sheet-body" style={{ paddingTop: 0 }}>
              <div className={`tab-panel${ecTab === "file" ? " active" : ""}`} data-panel="file">
                <div id="extraConfigDrop" className={`${ecFile ? "has-file" : ""} ${ecDrag ? "drag" : ""}`.trim()}
                  onClick={() => ecInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setEcDrag(true); }}
                  onDragLeave={() => setEcDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault(); setEcDrag(false);
                    if (e.dataTransfer.files.length) setEcFile(e.dataTransfer.files[0]);
                  }}>
                  <span id="extraConfigDropLabel">{ecFile ? ecFile.name : "Glisse un fichier .json ici ou clique pour en choisir un"}</span>
                  <input type="file" accept="application/json,.json" id="extraConfigInput" ref={ecInputRef} hidden
                    onChange={(e) => { if (e.target.files.length) setEcFile(e.target.files[0]); }} />
                </div>
              </div>
              <div className={`tab-panel${ecTab === "paste" ? " active" : ""}`} data-panel="paste">
                <textarea id="extraConfigText" ref={ecTextRef} spellCheck="false"
                  placeholder='{ "frontend_cvparser_config": [ ... ] }' value={ecText}
                  onChange={(e) => { setEcText(e.target.value); validateEcText(e.target.value); }} />
                <div id="extraConfigStatus" role="status" className={ecStatus.kind}>{ecStatus.text}</div>
              </div>
            </div>

            {error && <p className="error-msg">{error}</p>}
            <div className="sheet-foot">
              <button type="submit" id="submitBtn" className="btn primary" disabled={!pdf || busy}>
                <IconPlay /><span className="btn-label">{submitLabel}</span>
              </button>
            </div>
          </form>
        </div></main>
      </div>
    </>
  );
}
