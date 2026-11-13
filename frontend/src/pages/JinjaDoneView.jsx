import { IconDownload } from "../components/Icons";

function PreviewColumn({ title, pageCount, urlPrefix }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <p className="rail-title" style={{ margin: "0 0 8px" }}>{title}{pageCount > 0 && ` · ${pageCount} page${pageCount > 1 ? "s" : ""}`}</p>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {pageCount > 0 ? (
          Array.from({ length: pageCount }, (_, i) => (
            <img key={i} src={`${urlPrefix}-page-${i + 1}.png`} alt={`${title} page ${i + 1}`}
              style={{ width: "100%", display: "block", boxShadow: "var(--shadow-sheet)", borderRadius: 4 }} />
          ))
        ) : (
          <p className="hint">Prévisualisation indisponible (LibreOffice absent ou conversion échouée).</p>
        )}
      </div>
    </div>
  );
}

export default function JinjaDoneView({ result, effort, runId }) {
  const outPrefix = `/out/${runId}`;
  const hasPreview = (result.source_page_count > 0) || (result.template_page_count > 0);

  return (
    <main className="canvas"><div className="canvas-pad" style={{ gap: 16 }}>
      <div className="sheet">
        <div className="sheet-head">
          <div>
            <h2>Assets générés avec succès</h2>
            <p>Le template Jinja, les prompts et la configuration ont été créés à partir du CV.
              {effort && <> Raisonnement : <strong>{effort}</strong>.</>}</p>
          </div>
          <span style={{ color: "var(--good)", flex: "none" }}>✓</span>
        </div>
        <div className="sheet-body" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <a className="btn primary" href={result.template_url} download><IconDownload /><span>Template Jinja (.docx)</span></a>
          <a className="btn ghost" href={result.global_prompt_url} download><IconDownload /><span>Prompt Global (.md)</span></a>
          <a className="btn ghost" href={result.experience_prompt_url} download><IconDownload /><span>Prompt Expériences (.md)</span></a>
          <a className="btn ghost" href={result.config_url} download><IconDownload /><span>Extra Config (.json)</span></a>
        </div>
      </div>
    </div></main>
  );
}
