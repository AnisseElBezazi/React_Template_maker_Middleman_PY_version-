import { useCallback, useEffect, useRef, useState } from "react";

// La barre du bas flotte au-dessus du plan de travail : le cadrage lui
// reserve sa hauteur, sinon elle masque le pied des pages.
const MAX_Z = 8;
const FIT_PAD = 56;
const DOCK_SAFE = 52;
// Le plan de travail est borne : au-dela des pages, on ne peut decouvrir
// qu'une marge de vide, jamais les perdre de vue. La marge est
// proportionnelle a la fenetre pour rester franchissable a tout zoom.
const OVERSCROLL = 0.3;

/** Zoom et panoramique du plan de travail, fidele au comportement de
 * l'ancienne interface (run_view.js) : bornes de deplacement, zoom ancre
 * sous le curseur, raccourcis clavier, recadrage au redimensionnement. */
export function useViewport({ worldWidth, worldHeight, focusWidth, focusHeight, focusOffsetX, onTool, onOnionToggle }) {
  const viewportRef = useRef(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, z: 1 });
  const [panning, setPanning] = useState(false);
  const stateRef = useRef({ z: 1, tx: 0, ty: 0 });
  const panRef = useRef(null);
  const spaceDownRef = useRef(false);

  const fitZoom = useCallback((pad = FIT_PAD) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height || !worldWidth || !worldHeight) return 1;
    return Math.max(0.02, Math.min((r.width - pad * 2) / worldWidth, (r.height - DOCK_SAFE - pad * 2) / worldHeight));
  }, [worldWidth, worldHeight]);

  const clampZ = useCallback((v) => Math.max(fitZoom() * 0.5, Math.min(MAX_Z, v)), [fitZoom]);

  const apply = useCallback((next) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (r && r.width && r.height && worldWidth && worldHeight) {
      const m = Math.min(r.width, r.height) * OVERSCROLL;
      const bx = [m, r.width - worldWidth * next.z - m];
      const by = [m, r.height - worldHeight * next.z - m];
      next.tx = Math.min(Math.max(next.tx, Math.min(bx[0], bx[1])), Math.max(bx[0], bx[1]));
      next.ty = Math.min(Math.max(next.ty, Math.min(by[0], by[1])), Math.max(by[0], by[1]));
    }
    stateRef.current = next;
    setTransform({ x: next.tx, y: next.ty, z: next.z });
  }, [worldWidth, worldHeight]);

  const fitAll = useCallback((pad) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const z = fitZoom(pad);
    apply({ z, tx: (r.width - worldWidth * z) / 2, ty: (r.height - DOCK_SAFE - worldHeight * z) / 2 });
  }, [fitZoom, worldWidth, worldHeight, apply]);

  const fitPreview = useCallback(() => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r || !focusWidth || !focusHeight) return;
    const z = clampZ(Math.min((r.width - 64) / focusWidth, (r.height - DOCK_SAFE - 64) / focusHeight));
    apply({ z, tx: (r.width - focusWidth * z) / 2 - focusOffsetX * z, ty: (r.height - DOCK_SAFE - focusHeight * z) / 2 });
  }, [focusWidth, focusHeight, focusOffsetX, clampZ, apply]);

  const zoomAt = useCallback((clientX, clientY, factor) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = clientX - r.left, py = clientY - r.top;
    const { z, tx, ty } = stateRef.current;
    const nz = clampZ(z * factor);
    if (nz === z) return;
    apply({ z: nz, tx: px - (px - tx) * (nz / z), ty: py - (py - ty) * (nz / z) });
  }, [clampZ, apply]);

  const zoomCenter = useCallback((factor) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r) return;
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }, [zoomAt]);

  const centerOnWorld = useCallback((z = stateRef.current.z) => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r) return;
    apply({ z, tx: (r.width - worldWidth * z) / 2, ty: (r.height - worldHeight * z) / 2 });
  }, [worldWidth, worldHeight, apply]);

  const onWheelRaw = useCallback((e, clientX, clientY) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(clientX, clientY, Math.exp(-e.deltaY * 0.0025));
    } else {
      const { z, tx, ty } = stateRef.current;
      apply({ z, tx: tx - e.deltaX, ty: ty - e.deltaY });
    }
  }, [zoomAt, apply]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const onWheel = (e) => onWheelRaw(e, e.clientX, e.clientY);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [onWheelRaw]);

  const onPointerDown = useCallback((e) => {
    if (e.button === 2) return;
    if (e.target.closest(".dock")) return;
    const board = e.target.closest(".board");
    const onShield = e.target.classList.contains("board-shield");
    if (!(e.button === 1 || spaceDownRef.current || onShield || !board)) return;
    panRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, stx: stateRef.current.tx, sty: stateRef.current.ty };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e) => {
    const p = panRef.current;
    if (!p || e.pointerId !== p.pointerId) return;
    apply({ z: stateRef.current.z, tx: p.stx + (e.clientX - p.sx), ty: p.sty + (e.clientY - p.sy) });
  }, [apply]);

  const endPan = useCallback((e) => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* deja relache */ }
  }, []);

  // Raccourcis clavier : h/v/t/i/b changent d'outil, o bascule le calque,
  // +/- zooment, Maj+1 cadre tout, Espace autorise le panoramique n'importe ou.
  useEffect(() => {
    const setSpace = (down) => {
      if (spaceDownRef.current === down) return;
      spaceDownRef.current = down;
      document.body.classList.toggle("space", down);
    };
    const onKeyDown = (e) => {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === "Space") { setSpace(true); e.preventDefault(); return; }
      if (e.shiftKey && e.key === "!") { fitAll(); e.preventDefault(); return; }
      if (e.shiftKey && (e.key === "0" || e.key === "à")) { centerOnWorld(1); e.preventDefault(); return; }
      if (e.key === "+" || e.key === "=") { zoomCenter(1.2); e.preventDefault(); return; }
      if (e.key === "-") { zoomCenter(1 / 1.2); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const byKey = { h: "none", v: "all", t: "text", i: "img", b: "div" };
      if (byKey[k] && onTool) { onTool(byKey[k]); e.preventDefault(); return; }
      if (k === "o" && onOnionToggle) onOnionToggle();
    };
    const onKeyUp = (e) => { if (e.code === "Space") setSpace(false); };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => setSpace(false));
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [fitAll, centerOnWorld, zoomCenter, onTool, onOnionToggle]);

  // Recadrage au redimensionnement du panneau (ouverture/fermeture de la
  // barre laterale) : on decale de la moitie de ce qui a change, ce qui
  // garde le point central sous les yeux plutot que de tout recadrer.
  const sizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const ro = new ResizeObserver(() => {
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (!sizeRef.current.w) {
        fitAll();
      } else {
        const { z, tx, ty } = stateRef.current;
        apply({ z, tx: tx + (r.width - sizeRef.current.w) / 2, ty: ty + (r.height - sizeRef.current.h) / 2 });
      }
      sizeRef.current = { w: r.width, h: r.height };
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [fitAll, apply]);

  return {
    viewportRef,
    transform,
    panning,
    zoomPercent: Math.round(transform.z * 100),
    fitAll,
    fitPreview,
    zoomBy: zoomCenter,
    resetZoom: () => centerOnWorld(1),
    onWheelForFrame: (e, frameLeft, frameTop) => onWheelRaw(e, frameLeft + e.clientX * stateRef.current.z, frameTop + e.clientY * stateRef.current.z),
    handlers: { onPointerDown, onPointerMove, onPointerUp: endPan, onPointerCancel: endPan },
  };
}
