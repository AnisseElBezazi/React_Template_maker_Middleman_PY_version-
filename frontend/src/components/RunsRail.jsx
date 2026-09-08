import { IconLayers } from "./Icons";

// Recoit la liste deja preparee : le rail ne va pas la chercher lui-meme.
import { formatWhen } from "../hooks/formatWhen";

export default function RunsRail({ runs, currentId = null }) {
  const shown = runs.slice(0, currentId ? 6 : 14);
  return (
    <div className="rail-group">
      <p className="rail-title"><IconLayers /> Runs</p>
      {shown.length === 0 ? (
        <p style={{ padding: "0 12px", fontSize: 11.5, color: "var(--tx-3)", margin: 0 }}>
          Aucun run pour l'instant. Le premier apparaîtra ici.
        </p>
      ) : (
        <ul className="runlist">
          {shown.map((run, i) => (
            <li key={run.run_id}>
              <a href={`/runs/${run.run_id}`} aria-current={run.run_id === currentId ? "page" : undefined}>
                <span className={`dot ${run.status}`} title={run.status} />
                <span className="when">{formatWhen(run.started_at)}</span>
                {i === 0 && <span className="tag">dernier</span>}
                <span className="rid">{run.label || run.run_id}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
