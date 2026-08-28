import { IconDownload } from "../components/Icons";

export default function JinjaDoneView({ result }) {
  return (
    <main className="canvas"><div className="canvas-pad canvas-center">
      <div className="sheet">
        <div className="sheet-head">
          <div>
            <h2>Assets générés avec succès</h2>
            <p>Le template Jinja, les prompts et la configuration ont été créés à partir du CV.</p>
          </div>
          <span style={{ color: "var(--good)", flex: "none" }}>✓</span>
        </div>
        <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <a className="btn primary" href={result.template_url} download><IconDownload /><span>Template Jinja (.docx)</span></a>
          <a className="btn ghost" href={result.global_prompt_url} download><IconDownload /><span>Prompt Global (.md)</span></a>
          <a className="btn ghost" href={result.experience_prompt_url} download><IconDownload /><span>Prompt Expériences (.md)</span></a>
          <a className="btn ghost" href={result.config_url} download><IconDownload /><span>Extra Config (.json)</span></a>
        </div>
      </div>
    </div></main>
  );
}
