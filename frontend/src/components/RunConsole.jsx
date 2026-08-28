import { useEffect, useRef } from "react";
import { IconThink, IconWrite } from "./Icons";
import { STAGES } from "./StagesList";

const STAGE_NAMES = Object.fromEntries(STAGES.map((s) => [s.id, s.name]));

/** Un <pre> qui ne recolle en bas que si l'utilisateur y etait deja : sinon
 * relire un passage plus haut devient impossible a chaque mise a jour. */
function useStickyScroll(text) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  }, [text]);
  return ref;
}

export default function RunConsole({ log, stream }) {
  const logText = (log || []).map((l) => `[${l.step}] ${l.message}`).join("\n");
  const logRef = useStickyScroll(logText);
  const streamRef = useStickyScroll(stream?.text);

  const thinking = stream?.kind === "thinking";
  const hasStream = !!stream?.text;

  return (
    <>
      {hasStream && (
        <div className="console-block" id="streambox-wrap">
          <p className="console-head">
            <span id="streambox-icon">{thinking ? <IconThink /> : <IconWrite />}</span>
            <span className="stream-live" id="streambox-label">
              {thinking ? "Réflexion" : "Écriture"} — {STAGE_NAMES[stream.step] || stream.step}
            </span>
          </p>
          <pre className="console" id="streambox" ref={streamRef}>{stream.text}</pre>
        </div>
      )}
      <div className="console-block">
        <p className="console-head">Journal</p>
        <pre className="console" id="logbox" ref={logRef}>{logText}</pre>
      </div>
    </>
  );
}
