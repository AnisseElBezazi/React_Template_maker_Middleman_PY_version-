import { useEffect, useState } from "react";

/** Temps ecoule depuis le demarrage du run, mis a jour chaque seconde.
 * runId commence par un horodatage en millisecondes. */
export function useElapsed(runId) {
  const startedAt = parseInt((runId || "").split("-")[0], 10) || Date.now();
  const [text, setText] = useState("—");

  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      setText(`${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return text;
}
