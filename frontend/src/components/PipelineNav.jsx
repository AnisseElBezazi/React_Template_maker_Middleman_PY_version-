export default function PipelineNav({ active }) {
  return (
    <div style={{ marginBottom: 24, display: "flex", gap: 8 }}>
      <a href="/" className={`btn ${active === "pdf" ? "primary" : "ghost"}`}>PDF ➔ HTML</a>
      <a href="/jinja" className={`btn ${active === "jinja" ? "primary" : "ghost"}`}>CV ➔ Docx (Jinja)</a>
    </div>
  );
}
