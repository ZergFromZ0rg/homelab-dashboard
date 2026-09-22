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
function RebuildButton({ host, container, target }) {
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

  return (
    <div className="rebuild">
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled={running}
        onClick={run}
        title={`Pull and rebuild ${target.project}`}
      >
        {running ? "Rebuilding…" : "Rebuild"}
      </button>

      {target.can_pull === false && !job && !error && (
        <span
          className="rebuild-note"
          title={`${target.project}'s remote is ${
            target.remote || "not set"
          } — not a URL the agent can fetch, so it will build without pulling.`}
        >
          build only
        </span>
      )}

      {job?.state === "handed_off" && (
        <span className="rebuild-note" title={job.steps?.at(-1)?.output}>
          handed off — this agent is being replaced
        </span>
      )}

      {job?.state === "done" && <span className="rebuild-note">rebuilt</span>}

      {job?.state === "failed" && (
        <span
          className="rebuild-note rebuild-note--bad"
          title={failedStep?.output || job.error}
        >
          {job.error || "failed"}
        </span>
      )}

      {error && (
        <span className="rebuild-note rebuild-note--bad" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

export default RebuildButton;
