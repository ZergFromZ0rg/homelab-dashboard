import { useCallback, useEffect, useRef } from "react";
import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";
import { useLocalStorage } from "./useLocalStorage";
import { DEMO } from "../demoData";

// What happened to each briefing action you clicked. A clicked button turns
// into a one-line status that follows the real job (apt run, update job,
// reboot, move) and stays — through reloads and after the item itself has
// left "needs a yes" — until dismissed. Kept per browser.

const POLL_MS = 3000;
const REBOOT_GIVE_UP_MS = 15 * 60 * 1000;
// A reboot fast enough to fall between two ticks never shows as offline.
const REBOOT_UNSEEN_MS = 5 * 60 * 1000;
const KEEP_MS = 3 * 24 * 3600 * 1000;

const get = (url) => fetch(url).then(jsonOrThrow);
const tail = (log) => (log || "").trim().split("\n").slice(-6).join("\n");

// Start the action; returns the run to store.
export async function startRun(item, now = Date.now()) {
  const act = item.action;
  const run = { id: item.id, type: item.type, host: item.host, title: item.title, startedAt: now, state: "running" };
  try {
    if (DEMO) throw new Error("Demo mode — changes aren't saved.");
    const body = await confirmedFetch(act.url, {
      method: act.method || "POST",
      headers: act.body ? { "Content-Type": "application/json" } : undefined,
      body: act.body ? JSON.stringify(act.body) : undefined,
    }).then(jsonOrThrow);

    if (item.type === "container_updates") return { ...run, jobId: body.id };
    if (item.type === "rebalance") {
      return { ...run, state: "done", endedAt: Date.now(), note: body.placed_on ? `Moved to ${body.placed_on}` : "Moved" };
    }
    if (item.type === "os_upgrade" || item.type === "reboot") return run;
    return { ...run, state: "done", endedAt: Date.now(), note: "Done" };
  } catch (e) {
    return { ...run, state: "failed", endedAt: Date.now(), note: "Didn't start", detail: e.message };
  }
}

// One step of following a running run. Returns the run unchanged while
// there's nothing new; a failed poll just waits for the next one.
export async function advance(run, { machines, now = Date.now() } = {}) {
  const host = encodeURIComponent(run.host);
  const end = (state, note, detail) => ({ ...run, state, note, detail, endedAt: now });

  if (run.type === "os_upgrade") {
    const s = await get(`/api/hosts/${host}/os-updates/status`).catch(() => null);
    if (!s || s.running) return run;
    return s.exit_code === 0
      ? end("done", "Installed", tail(s.log))
      : end("failed", `apt exited ${s.exit_code ?? "?"}`, tail(s.log));
  }

  if (run.type === "container_updates") {
    if (!run.jobId) return end("failed", "No job", null);
    const job = await get(`/api/updates/${host}/jobs/${encodeURIComponent(run.jobId)}`).catch(() => null);
    if (!job || job.state === "running" || job.state === "starting") return run;
    const results = Object.entries(job.results || {}).map(([p, r]) => `${p}: ${r}`).join("\n");
    if (job.state === "done") return end("done", "Updated", results);
    if (job.state === "rolled_back") return end("failed", "Rolled back", job.error || results);
    return end("failed", "Update failed", job.error || results);
  }

  if (run.type === "reboot") {
    const m = machines?.[run.host];
    const up = Boolean(m?.online) && m?.agent_reachable !== false;
    if (!up) {
      if (now - run.startedAt > REBOOT_GIVE_UP_MS) return end("failed", "Not back", "Still offline 15 minutes after the reboot");
      return run.sawDown ? run : { ...run, sawDown: true };
    }
    if (run.sawDown) return end("done", "Back up", null);
    if (now - run.startedAt > REBOOT_UNSEEN_MS) return end("done", "Up", "Never seen offline — the reboot may have been quick, or not happened");
    return run;
  }

  return run;
}

export function useActionRuns(machines) {
  const [runs, setRuns] = useLocalStorage("morningRuns", {});
  const machinesRef = useRef(machines);
  useEffect(() => {
    machinesRef.current = machines;
  }, [machines]);

  // A reload mid-request leaves a run "starting" with no way to know how it
  // went; say so rather than spin forever.
  useEffect(() => {
    const cut = Date.now() - 60 * 1000;
    const orphaned = Object.values(runs || {}).filter((r) => r.state === "starting" && r.startedAt < cut);
    if (orphaned.length) {
      setRuns((all) => ({
        ...all,
        ...Object.fromEntries(orphaned.map((r) => [r.id, { ...r, state: "failed", note: "Unknown", detail: "The page reloaded before the request answered — check the host", endedAt: Date.now() }])),
      }));
    }
  }, [runs, setRuns]);

  // Drop finished runs older than a few days.
  useEffect(() => {
    const cutoff = Date.now() - KEEP_MS;
    const stale = Object.values(runs || {}).filter((r) => (r.state === "done" || r.state === "failed") && (r.endedAt || r.startedAt) < cutoff);
    if (stale.length) {
      setRuns((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !stale.some((r) => r.id === id))));
    }
  }, [runs, setRuns]);

  const running = Object.values(runs || {}).filter((r) => r.state === "running");
  const runningKey = running.map((r) => `${r.id}:${r.sawDown ? 1 : 0}`).join(",");

  useEffect(() => {
    if (!runningKey) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      const current = Object.values(runs || {}).filter((r) => r.state === "running");
      for (const run of current) {
        const next = await advance(run, { machines: machinesRef.current });
        if (!cancelled && next !== run) {
          setRuns((all) => (all[run.id]?.startedAt === run.startedAt ? { ...all, [run.id]: next } : all));
        }
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // runs is read fresh whenever the running set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey, setRuns]);

  const start = useCallback(
    async (item) => {
      setRuns((all) => ({ ...all, [item.id]: { id: item.id, type: item.type, host: item.host, title: item.title, startedAt: Date.now(), state: "starting" } }));
      const run = await startRun(item);
      setRuns((all) => ({ ...all, [item.id]: run }));
    },
    [setRuns]
  );

  const dismiss = useCallback(
    (id) => setRuns((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id))),
    [setRuns]
  );

  return { runs: runs || {}, start, dismiss };
}
