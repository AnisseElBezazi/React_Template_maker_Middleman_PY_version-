export default function PassesList({ passes }) {
  const other = passes.slice(0, -1);
  const final = passes[passes.length - 1];
  return (
    <div className="rail-group">
      <p className="rail-title">Passes</p>
      <ul className="passlist">
        {other.map((p, i) => (
          <li key={p.name}>
            <a href={p.html_url} target="_blank" rel="noopener noreferrer">
              <span className="n">{i + 1}</span>{p.label}
            </a>
          </li>
        ))}
        <li className="cur"><span><span className="n">{passes.length}</span>{final.label}</span></li>
      </ul>
    </div>
  );
}
