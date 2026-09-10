import { Logo } from "./Icons";

export default function Toolbar({ crumb, status, actions }) {
  return (
    <header className="toolbar">
      <a className="brand" href="/" title="Retour à l'accueil"><Logo /><b>Design-to-Code</b></a>
      {crumb && <><div className="tb-sep" /><nav className="crumb">{crumb}</nav></>}
      <div className="tb-right">{status}{actions}</div>
    </header>
  );
}
