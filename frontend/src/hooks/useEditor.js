import { useCallback, useEffect, useRef, useState } from "react";

const CV_TAGS_VERSION = "4";
const EDIT_TOOLS = new Set(["all", "text", "img", "div"]);
export const isEditTool = (t) => EDIT_TOOLS.has(t);

/** Pilote l'iframe de preview : injection du script d'edition, communication
 * par postMessage, etat de selection/outil/calque, enregistrement. Le script
 * injecte (editor-overlay.js) reste du JS vanilla -- il manipule le DOM
 * RENDU par le composant genere dans l'iframe, pas du React. */
export function useEditor({ runId, frameRef, onFocusPreview }) {
  const [tool, setToolState] = useState("none");
  const [onionOn, setOnionOn] = useState(false);
  const [onionOpacity, setOnionOpacity] = useState(45);
  const [selection, setSelection] = useState(null);
  const [spacingMode, setSpacingModeState] = useState("padding");
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState("Aucune modification");
  const [saving, setSaving] = useState(false);

  const overlayReadyRef = useRef(false);
  const overlayBusyRef = useRef(false);
  const readyResolveRef = useRef(null);
  const currentEditsRef = useRef({ images: {}, texts: {}, classes: {} });
  const toolRef = useRef("none");
  toolRef.current = tool;

  const post = useCallback((msg) => {
    const win = frameRef.current?.contentWindow;
    if (win) win.postMessage(msg, "*");
  }, [frameRef]);

  const waitReady = useCallback((ms) => new Promise((resolve) => {
    readyResolveRef.current = resolve;
    setTimeout(() => {
      if (readyResolveRef.current === resolve) { readyResolveRef.current = null; resolve(false); }
    }, ms);
  }), []);

  /** Injecte le script d'edition si besoin. needTags n'est vrai que pour les
   * outils qui selectionnent : le calque n'a pas besoin des reperes. */
  const ensureOverlay = useCallback(async (needTags) => {
    if (overlayReadyRef.current) return true;
    if (overlayBusyRef.current) return false;
    overlayBusyRef.current = true;
    try {
      const frame = frameRef.current;
      if (needTags) {
        const meta = frame.contentDocument.querySelector('meta[name="cv-tags"]');
        if (!meta || meta.content !== CV_TAGS_VERSION) {
          setStatus("Préparation de l'éditeur...");
          const rr = await fetch(`/api/runs/${runId}/rerender`, { method: "POST" });
          if (!rr.ok) { setStatus(`Préparation échouée : ${await rr.text()}`); return false; }
          await new Promise((resolve) => {
            frame.addEventListener("load", resolve, { once: true });
            frame.src = frame.src.split("?")[0] + "?t=" + Date.now();
          });
        }
      }
      const code = await (await fetch(`/editor-overlay.js?t=${Date.now()}`)).text();
      const el = frame.contentDocument.createElement("script");
      el.textContent = code;
      const ready = waitReady(4000);
      frame.contentDocument.body.appendChild(el);
      if (!(await ready)) {
        setStatus("L'éditeur ne s'est pas initialisé — regarde la console du navigateur.");
        return false;
      }
      return true;
    } catch (err) {
      setStatus(`Erreur : ${err.message}`);
      console.error(err);
      return false;
    } finally {
      overlayBusyRef.current = false;
    }
  }, [runId, frameRef, waitReady]);

  const pushOnion = useCallback((on, opacity, target) => {
    post({ type: "cv-onion", src: target, on, opacity: opacity / 100 });
  }, [post]);

  const setTool = useCallback(async (next) => {
    if (next === toolRef.current) return;
    if (isEditTool(next)) {
      if (!(await ensureOverlay(true))) return;
      if (!isEditTool(toolRef.current) && onFocusPreview) onFocusPreview();
    }
    setToolState(next);
    post({ type: "cv-settool", tool: next });
    if (!isEditTool(next)) {
      post({ type: "cv-deselect" });
      setSelection(null);
    }
  }, [ensureOverlay, post, onFocusPreview]);

  const setOnion = useCallback(async (on, target) => {
    if (on && !(await ensureOverlay(false))) return;
    setOnionOn(on);
    pushOnion(on, onionOpacity, target);
  }, [ensureOverlay, pushOnion, onionOpacity]);

  const setSpacingMode = useCallback((mode) => {
    setSpacingModeState(mode);
    post({ type: "cv-setmode", mode });
  }, [post]);

  useEffect(() => {
    const onMessage = (e) => {
      if (!e.data) return;
      if (e.data.type === "cv-editor-ready") {
        overlayReadyRef.current = true;
        if (readyResolveRef.current) { const r = readyResolveRef.current; readyResolveRef.current = null; r(true); }
        const parts = [];
        if (e.data.count) parts.push(`${e.data.count} image${e.data.count > 1 ? "s" : ""}`);
        if (e.data.texts) parts.push(`${e.data.texts} texte${e.data.texts > 1 ? "s" : ""}`);
        setStatus(parts.length ? `${parts.join(" · ")} éditables` : "Rien d'éditable dans ce rendu");
        post({ type: "cv-settool", tool: toolRef.current });
      }
      if (e.data.type === "cv-select") {
        setSelection(e.data.sel);
      }
      if (e.data.type === "cv-edits") {
        currentEditsRef.current = { images: e.data.edits || {}, texts: e.data.textEdits || {}, classes: e.data.classEdits || {} };
        const n = Object.keys(currentEditsRef.current.images).length
          + Object.keys(currentEditsRef.current.texts).length
          + Object.keys(currentEditsRef.current.classes).length;
        setPendingCount(n);
        setStatus(n ? `${n} modification(s) en attente` : "Aucune modification");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

  const setImageGeom = useCallback((prop, value) => {
    post({ type: "cv-setgeom-em", [prop]: value });
  }, [post]);

  const setSpacingSide = useCallback((side, em) => {
    post({ type: "cv-setspacing-em", side, em });
  }, [post]);

  const undo = useCallback(() => post({ type: "cv-undo" }), [post]);
  const redo = useCallback(() => post({ type: "cv-redo" }), [post]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus("Enregistrement...");
    try {
      const r = await fetch(`/api/runs/${runId}/image-edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edits: currentEditsRef.current.images,
          textEdits: currentEditsRef.current.texts,
          classEdits: currentEditsRef.current.classes,
        }),
      });
      if (r.ok) {
        window.location.reload();
      } else {
        setSaving(false);
        setStatus(`Échec : ${await r.text()}`);
      }
    } catch (err) {
      setSaving(false);
      setStatus(`Échec : ${err.message}`);
    }
  }, [runId]);

  const cancel = useCallback((target) => {
    const frame = frameRef.current;
    if (frame) frame.src = frame.src;
    currentEditsRef.current = { images: {}, texts: {}, classes: {} };
    overlayReadyRef.current = false;
    setToolState("none");
    setOnionOn(false);
    setPendingCount(0);
    setStatus("Aucune modification");
    setSelection(null);
  }, [frameRef]);

  return {
    tool, setTool, onionOn, setOnion, onionOpacity, setOnionOpacity, pushOnion,
    selection, spacingMode, setSpacingMode, pendingCount, status, saving,
    setImageGeom, setSpacingSide, undo, redo, save, cancel,
  };
}
