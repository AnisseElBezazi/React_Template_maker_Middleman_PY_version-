import { useEffect, useRef, useState } from "react";
import { IconChat, IconClose, IconPlay } from "./Icons";
import { sendChatEdit } from "../api/runs_api";

/** Panneau de chat ancre en bas de l'ecran, sur la page d'edit d'un run JSX
 * termine : permet de demander une correction en langage naturel plutot que
 * de tout reprendre a la souris quand un detail est mal sorti au premier jet.
 * Chaque envoi reecrit le composant genere puis recharge la page -- meme
 * mecanique que "Enregistrer" dans l'editeur souris (useEditor.save). */
export default function ChatPanel({ runId, open, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  if (!open) return null;

  async function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await sendChatEdit(runId, text);
      // Un controle technique gratuit (conventions data-block-id, cvData?.,
      // saleInfo...) tourne systematiquement apres l'edition -- montrer ce
      // qu'il a trouve rassure sur le fait qu'il tourne vraiment, plutot que
      // de recharger la page sans rien laisser voir.
      const findings = res.audit_findings || [];
      setMessages((m) => [...m, {
        role: "ok",
        text: findings.length
          ? `Fait -- ${findings.length} point technique corrigé automatiquement (${findings.join(", ")}).`
          : "Fait -- aucune anomalie technique détectée.",
      }]);
      await new Promise((r) => setTimeout(r, 900));
      window.location.reload();
    } catch (err) {
      setMessages((m) => [...m, { role: "error", text: err.message }]);
      setBusy(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title"><IconChat /> Modifier par chat</span>
        <button type="button" className="btn ghost chat-close" onClick={onClose} title="Fermer">
          <IconClose />
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-empty">
            Décris la modification à apporter au CV (ex : « le titre du poste doit être plus gros », « l'icône
            email n'est pas alignée avec le texte »). Chaque envoi relance une génération et remplace le composant
            actuel.
          </p>
        )}
        {messages.map((m, i) => (
          <p key={i} className={`chat-msg ${m.role}`}>{m.text}</p>
        ))}
        {busy && <p className="chat-msg pending">Modification en cours...</p>}
      </div>
      <form className="chat-input-row" onSubmit={handleSend}>
        <input
          type="text"
          placeholder="Décris la modification..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button type="submit" className="btn primary" disabled={busy || !input.trim()}>
          <IconPlay /><span>Envoyer</span>
        </button>
      </form>
    </div>
  );
}
