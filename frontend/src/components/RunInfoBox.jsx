export default function RunInfoBox({ children }) {
  return (
    <div className="rail-group">
      <p className="rail-title">Ce run</p>
      <dl className="kv">{children}</dl>
    </div>
  );
}

export function KvRow({ label, value }) {
  if (value === null || value === undefined) return null;
  return <div className="kv-row"><dt>{label}</dt><dd>{value}</dd></div>;
}
