import { useRef } from "react";

/** Champ numerique qu'on peut ajuster en glissant la souris sur son libelle
 * (comme dans un logiciel de creation), ou a la molette, en plus de la
 * saisie clavier normale. */
export default function ScrubInput({ label, value, min, onChange }) {
  const dragRef = useRef(null);

  const step = (e) => (e.shiftKey ? 1.0 : e.altKey ? 0.01 : 0.1);
  const clamp = (v) => (min !== undefined && v < min ? min : v);

  const onPointerDown = (e) => {
    dragRef.current = { startX: e.clientX, startVal: Number(value) || 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("scrubbing");
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const newVal = Math.round((dragRef.current.startVal + dx * step(e) * 0.5) * 100) / 100;
    onChange(clamp(newVal));
  };
  const endDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.classList.remove("scrubbing");
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* deja relache */ }
  };
  const onWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? step(e) : -step(e);
    onChange(clamp(Math.round(((Number(value) || 0) + delta) * 100) / 100));
  };

  return (
    <div className="sb-row scrubbable" title="Glisser la souris ou utiliser la molette">
      <span onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag}
        onPointerCancel={endDrag} onWheel={onWheel}>{label}</span>
      <input type="number" step="0.1" min={min} className="pad-in" value={value}
        onChange={(e) => onChange(Number(e.target.value))} onWheel={onWheel} />
    </div>
  );
}
