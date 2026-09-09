import { useEffect, useState } from "react";
import { fetchRun, fetchRunStatus } from "../api/runs_api";

const POLL_MS = 1000;

/** Charge un run et, tant qu'il tourne, suit sa progression. Recharge l'etat
 * complet une seule fois, a la bascule vers "done" : inutile de retelecharger
 * passes et metriques a chaque tick. */
export function useRun(runId) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!runId) return undefined;
    let stopped = false;
    let timer = null;

    const poll = async () => {
      try {
        const status = await fetchRunStatus(runId);
        if (stopped) return;
        if (status.status === "running") {
          // Fusion legere : "result" n'existe pas dans cette reponse (voir
          // get_run_status), donc merger un statut terminal ("done"/"error")
          // ici laisserait "run.status" passer a "done" avant que
          // "run.result" n'existe -- DoneView plante alors sur `r.width`
          // (r === null), page blanche jusqu'au refresh manuel. On ne merge
          // donc QUE tant que ca tourne, et on bascule direct sur l'etat
          // complet des que ce n'est plus le cas.
          setRun((prev) => (prev ? { ...prev, ...status } : prev));
          timer = setTimeout(poll, POLL_MS);
        } else {
          const full = await fetchRun(runId);
          if (!stopped) setRun(full);
        }
      } catch (err) {
        if (!stopped) setError(err.message);
      }
    };

    fetchRun(runId)
      .then((full) => {
        if (stopped) return;
        setRun(full);
        if (full.status === "running") timer = setTimeout(poll, POLL_MS);
      })
      .catch((err) => { if (!stopped) setError(err.message); });

    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [runId]);

  return { run, error };
}
