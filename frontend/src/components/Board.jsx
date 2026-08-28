const PAGE_GAP = 24;

/** Coupures entre deux pages. Le rendu et la cible empilent leurs pages avec
 * 24px de blanc, invisible sur du papier blanc : on repeint cette bande a la
 * couleur du canevas et on y projette l'ombre des deux feuilles, pour qu'une
 * fin de page se lise d'un coup d'oeil. */
function pageGapTops(pageHeights) {
  return pageHeights.slice(0, -1).map((_, i) =>
    pageHeights.slice(0, i + 1).reduce((a, b) => a + b, 0) + PAGE_GAP * i);
}

export default function Board({ id, left, width, height, label, sublabel, pageHeights = [], className = "", children }) {
  return (
    <div className={`board${className ? ` ${className}` : ""}`} id={id} style={{ left, width, height }}>
      <p className="frame-name">{label}{sublabel && <span className="fn-sub">{sublabel}</span>}</p>
      {children}
      {pageGapTops(pageHeights).map((top) => (
        <div key={top} className="page-gap" style={{ top, height: PAGE_GAP }} />
      ))}
      <div className="board-shield" />
    </div>
  );
}
