import { IconHand, IconCursor, IconText, IconImage, IconBlock, IconOnion, IconMinus, IconPlus, IconFit } from "./Icons";

const TOOLS = [
  { id: "none", title: "Parcourir — H", Icon: IconHand },
  { id: "all", title: "Sélection — V", Icon: IconCursor },
  { id: "text", title: "Texte — T", Icon: IconText },
  { id: "img", title: "Image — I", Icon: IconImage },
  { id: "div", title: "Bloc (conteneur) — B", Icon: IconBlock },
];

export default function Dock({ tool, onToolChange, onionOn, onOnionToggle, onionAvailable,
                                 zoomPercent, onZoomIn, onZoomOut, onFit, onZoomReset }) {
  return (
    <div className="dock" role="toolbar" aria-label="Outils">
      {TOOLS.map(({ id, title, Icon }) => (
        <button key={id} type="button" className="tool" data-tool={id}
          aria-pressed={tool === id} title={title}
          onClick={() => onToolChange(id)}><Icon /></button>
      ))}
      <span className="zsep" />
      <button type="button" id="onionBtn" aria-pressed={onionOn} title="Calque de la cible — O"
        disabled={!onionAvailable} onClick={onOnionToggle}><IconOnion /></button>
      <span className="zsep" />
      <button type="button" id="zOut" title="Dézoomer" aria-label="Dézoomer" onClick={onZoomOut}><IconMinus /></button>
      <button type="button" id="zVal" className="zval" title="Revenir à 100 %" onClick={onZoomReset}>{zoomPercent} %</button>
      <button type="button" id="zIn" title="Zoomer" aria-label="Zoomer" onClick={onZoomIn}><IconPlus /></button>
      <button type="button" id="zFit" title="Tout afficher — Maj+1" aria-label="Tout afficher" onClick={onFit}><IconFit /></button>
    </div>
  );
}
