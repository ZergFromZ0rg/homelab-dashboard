import { useEffect, useRef, useState } from "react";
import { fetchRebuildJob, startRebuild } from "./rebuildApi";

const POLL_MS = 2000;

// Pull a container's Compose project and bring it back up with --build.
//
// Shown only where the agent reported a target — a Compose project whose
// directory is a git checkout — and only when that host has opted in, so
// the absence of this button is itself the answer.
//
// It also shows for the agent's own container, which `Protected` otherwise
// hides every control on: protection is about not stopping or deleting the
// agent, whereas replacing it with a newer build is the whole point.
//
// Split in two for the dense container row: the button is one icon among
// the row's actions, and what became of the click (rebuilding…, rebuilt,
// failed) is a chip next to the name, where there's room for it.
export function useRebuild(host, container, target) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function poll(jobId) {
    timer.current = setTimeout(async () => {
      try {
        const next = await fetchRebuildJob(host, jobId);
        setJob(next);
        if (next.state === "running") poll(jobId);
      } catch (e) {
        // The agent going away mid-rebuild is expected when it's the one
        // being replaced — that isn't a failure, it's the point.
        setError(e.message);
      }
    }, POLL_MS);
  }

  async function run() {
    const what = target.service || container.name;

    // An ssh remote is fine — the agent reads the same public repo over
    // https. This is only false for a remote that's no kind of fetchable
    // URL at all, like a local path.
    const pull = target.can_pull !== false;

    const ok = window.confirm(
      `Rebuild ${what} on ${host}?\n\n` +
        (pull
          ? `This runs "git pull" and "docker compose up -d --build" in `
          : `This runs "docker compose up -d --build" in `) +
        `${target.project} on that host — whatever the repo and its ` +
        `Dockerfile say.` +
        (pull
          ? ""
          : `\n\nIt won't pull first: ${target.project}'s remote is ` +
            `${target.remote || "not set"}, which isn't a URL the agent can ` +
            `fetch over http(s). Pull on the host yourself.`)
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    setJob(null);

    try {
      const started = await startRebuild(host, container.id, { pull });
      setJob(started);
      if (started.state === "running") poll(started.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const running = busy || job?.state === "running";
  const failedStep = job?.steps?.find((s) => s.exit_code);

  let note = null;
  if (running) note = { text: "rebuilding…", tone: "busy" };
  else if (error) note = { text: "rebuild failed", tone: "bad", title: error, dismiss: true };
  else if (job?.state === "failed")
    note = { text: "rebuild failed", tone: "bad", title: failedStep?.output || job.error, dismiss: true };
  else if (job?.state === "handed_off")
    note = { text: "handed off", tone: "busy", title: `This agent is being replaced.\n${job.steps?.at(-1)?.output ?? ""}` };
  else if (job?.state === "done") note = { text: "rebuilt", tone: "ok", dismiss: true };

  // Called for every row (hooks can't be conditional); most have no target.
  const buildOnly = target?.can_pull === false;
  const title = buildOnly
    ? `Rebuild ${target.project} (build only: its remote is ${target.remote || "not set"}, which the agent can't fetch)`
    : `Pull and rebuild ${target?.project}`;

  const dismiss = () => {
    setJob(null);
    setError(null);
  };

  return { run, running, note, title, dismiss };
}
