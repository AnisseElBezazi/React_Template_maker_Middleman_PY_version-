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
        setRun((prev) => (prev ? { ...prev, ...status } : prev));
        if (status.status === "running") {
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
