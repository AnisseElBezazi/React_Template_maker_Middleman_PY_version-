import { Logo } from "./Icons";

export default function Toolbar({ crumb, status, actions }) {
  return (
    <header className="toolbar">
      <div className="brand"><Logo /><b>Design-to-Code</b></div>
      {crumb && <><div className="tb-sep" /><nav className="crumb">{crumb}</nav></>}
      <div className="tb-right">{status}{actions}</div>
    </header>
  );
}
