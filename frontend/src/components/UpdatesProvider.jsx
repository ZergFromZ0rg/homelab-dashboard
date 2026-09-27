import { useCallback, useEffect, useMemo, useState } from "react";
import { UpdatesContext } from "./updatesContext";
import { fetchUpdateJob, startUpdate } from "./updatesApi";

const POLL_MS = 2000;

// Holds each host's current (or last) update job and follows it until it
// ends. A job updates whole Compose projects — pull, recreate, watch, roll
// back on failure — so a row is "updating" while its project is in one.
function UpdatesProvider({ children }) {
  const [jobs, setJobs] = useState({});

  const start = useCallback(async (host, containers) => {
    setJobs((all) => ({ ...all, [host]: { state: "starting", projects: [], results: {} } }));
    try {
      const job = await startUpdate(host, containers);
      setJobs((all) => ({ ...all, [host]: job }));
    } catch (e) {
      setJobs((all) => ({ ...all, [host]: { state: "failed", error: e.message, projects: [], results: {} } }));
    }
  }, []);

  const dismiss = useCallback((host) => {
    setJobs((all) => {
      const next = { ...all };
      delete next[host];
      return next;
    });
  }, []);

  // Poll every running job; a failed poll (the dashboard restarting under
  // us, say) just tries again next time.
  useEffect(() => {
    const running = Object.entries(jobs).filter(([, j]) => j.state === "running" && j.id);
    if (!running.length) return undefined;
    const timer = setTimeout(() => {
      running.forEach(([host, j]) =>
        fetchUpdateJob(host, j.id)
          .then((next) => setJobs((all) => (all[host]?.id === j.id ? { ...all, [host]: next } : all)))
          .catch(() => setJobs((all) => ({ ...all })))
      );
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [jobs]);

  const value = useMemo(() => ({ jobs, start, dismiss }), [jobs, start, dismiss]);
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export default UpdatesProvider;
