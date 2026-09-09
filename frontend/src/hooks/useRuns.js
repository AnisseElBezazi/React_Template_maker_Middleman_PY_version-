import { useEffect, useState } from "react";
import { fetchRuns } from "../api/runs_api";

const POLL_MS = 2000;

/** Liste des runs (rail de gauche), reinterrogee en continu : plusieurs runs
 * peuvent tourner en parallele et leur statut doit s'actualiser sans recharger
 * la page. */
export function useRuns() {
  const [runs, setRuns] = useState([]);
  useEffect(() => {
    let stopped = false;
    let timer = null;

    const poll = () => {
      fetchRuns()
        .then((data) => {
          if (stopped) return;
          setRuns(data.runs);
          timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (!stopped) timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();

    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);
  return runs;
}
