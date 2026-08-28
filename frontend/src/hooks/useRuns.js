import { useEffect, useState } from "react";
import { fetchRuns } from "../api/runs_api";

export function useRuns() {
  const [runs, setRuns] = useState([]);
  useEffect(() => {
    let stopped = false;
    fetchRuns()
      .then((data) => { if (!stopped) setRuns(data.runs); })
      .catch(() => { if (!stopped) setRuns([]); });
    return () => { stopped = true; };
  }, []);
  return runs;
}
