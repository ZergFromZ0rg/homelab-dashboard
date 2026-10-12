import { useEffect, useId, useRef, useState } from "react";
import { DEMO } from "../demoData";
import FleetUpdate from "./FleetUpdate";
import Icon from "./Icon";
import { formatWhen } from "./format";
import { fetchGitUpdates, setGitUpdates } from "./gitUpdatesApi";
import { hostColor } from "./hostColor";
import "./GitUpdates.css";

const POLL_MS = 5000;
const DEMO_DATA = {
  hosts: [{
    host: "bigboy", available: true, enabled: true, poll_seconds: 15,
    projects: [{
      id: "dashboard", project: "homelab-dashboard", working_dir: "/srv/homelab-dashboard",
      repository: "https://github.com/example/homelab-dashboard", branch: "main",
      containers: ["dashboard", "backend"], enabled: false, state: "disabled", can_enable: true,
    }],
  }],
};

function repositoryLink(repository) {
  try {
    const url = new URL(repository);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* SSH remotes and invalid URLs stay plain text. */ }
  return null;
}

function projectStatus(project) {
  if (!project.enabled) return "Off";
  if (project.error && !["building", "updating"].includes(project.state)) return "Update failed";
  const labels = {
    waiting: "Waiting to update", pending: "Pending first check", checking: "Checking for changes…",
    building: "Pulling and rebuilding…", updating: "Pulling and rebuilding…",
    failed: "Update failed", blocked: "Needs attention",
  };
  return labels[project.state] || (project.last_checked_at ? "Watching for pushes" : "Pending first check");
}

function Project({ host, project, demo, saving, error, stale, onChange }) {
  const descriptionId = useId();
  const href = repositoryLink(project.repository);
  const hasError = Boolean(error || project.error || project.state === "failed");
  const busy = ["building", "updating", "checking", "waiting"].includes(project.state);
  return (
    <li className="git-updates-project">
      <div className="git-updates-project-info">
        <div className="git-updates-project-title">
          <strong>{project.project}</strong>
          {project.branch && <span className="git-updates-branch">{project.branch}</span>}
          <span className={`git-updates-state ${hasError ? "git-updates-state--bad" : busy ? "git-updates-state--busy" : ""}`}>
            {saving ? "Saving…" : projectStatus(project)}
          </span>
        </div>
        <div className="git-updates-repository">
          {href ? <a href={href} target="_blank" rel="noopener noreferrer">{project.repository}</a> : <span>{project.repository || "Git remote unavailable"}</span>}
        </div>
        <div className="git-updates-meta">
          <span title={project.working_dir}>{project.working_dir}</span>
          {project.containers?.length > 0 && <span>{project.containers.join(", ")}</span>}
        </div>
        {(project.last_checked_at || project.last_deployed_at) && (
          <div className="git-updates-meta">
            {project.last_checked_at && <span>Checked {formatWhen(project.last_checked_at)}</span>}
            {project.last_deployed_at && <span>Updated {formatWhen(project.last_deployed_at)}{project.last_deployed_sha && <> · <code>{project.last_deployed_sha.slice(0, 7)}</code></>}</span>}
          </div>
        )}
        <div id={descriptionId}>
          {project.reason && <p className="git-updates-note">{project.reason}</p>}
          {(error || project.error) && <p className="git-updates-error" role="alert">{error || project.error}</p>}
        </div>
      </div>
      <label className="git-updates-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Automatic updates for ${project.project} on ${host}`}
          aria-describedby={descriptionId}
          checked={Boolean(project.enabled)}
          disabled={demo || saving || stale || (!project.enabled && project.can_enable === false)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="git-updates-switch-track" aria-hidden="true" />
        <span>{project.enabled ? "On" : "Off"}</span>
      </label>
    </li>
  );
}

function GitUpdatesBody({ demo, machines }) {
  const [data, setData] = useState(demo ? DEMO_DATA : null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState({});
  const [saveErrors, setSaveErrors] = useState({});
  const pending = useRef(new Set());
  const revision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (demo) return () => { mounted.current = false; };
    const controller = new AbortController();
    let timer;
    async function refresh() {
      const requestRevision = revision.current;
      try {
        // A listing begun before a save must not overwrite its response.
        if (pending.current.size) return;
        const next = await fetchGitUpdates(controller.signal);
        if (!controller.signal.aborted && requestRevision === revision.current) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, POLL_MS);
      }
    }
    refresh();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [demo]);

  async function select(host, project, enabled) {
    const key = `${host}/${project.id}`;
    if (demo || pending.current.has(key)) return;
    revision.current += 1;
    pending.current.add(key);
    setSaving((old) => ({ ...old, [key]: true }));
    setSaveErrors((old) => ({ ...old, [key]: null }));
    try {
      const updated = await setGitUpdates(host, project.id, enabled);
      if (mounted.current) setData((old) => ({
        ...old,
        hosts: old.hosts.map((item) => item.host !== host ? item : {
          ...item, projects: item.projects.map((p) => p.id === project.id ? updated : p),
        }),
      }));
    } catch (e) {
      if (mounted.current) setSaveErrors((old) => ({ ...old, [key]: e.message }));
    } finally {
      revision.current += 1;
      pending.current.delete(key);
      if (mounted.current) setSaving((old) => ({ ...old, [key]: false }));
    }
  }

  const hosts = data?.hosts || [];
  const oldAgents = hosts.some((host) => [404, 405, 501].includes(host.status_code));
  return (
    <div className="git-updates-body">
      <p className="git-updates-intro">Choose repositories to pull and rebuild after you push to their current branch. Hosts and repositories are detected from running Docker Compose projects. Changes are checked every 15 seconds; rebuilding takes additional time.</p>
      <p className="git-updates-note">Each repository starts off. Turning one on also applies any changes already pushed. Updates keep running when this dashboard is closed.</p>
      {demo && <p className="git-updates-note">Demo preview — switches are read-only.</p>}
      {error && <p className="git-updates-error" role="alert">Could not refresh automatic updates: {error}. Retrying…</p>}
      {!data && !error && <p className="git-updates-note" role="status">Finding repositories on your hosts…</p>}
      {data && hosts.length === 0 && <p className="git-updates-note">No hosts found. Connect a host agent and run a Docker Compose project from a cloned Git repository to discover it here.</p>}
      {oldAgents && !demo && Object.keys(machines).length > 0 && (
        <div className="git-updates-agent-update"><span>Update older agents to discover their repositories.</span><FleetUpdate machines={machines} /></div>
      )}
      {hosts.map((host) => (
        <section className="git-updates-host" key={host.host} style={{ "--host-color": hostColor(host.host) }} aria-label={`Repositories on ${host.host}`}>
          <h3>{host.host}<span>{host.poll_seconds ? `Checks every ${host.poll_seconds}s` : ""}</span></h3>
          {!host.available && <p className="git-updates-note">{[404, 405, 501].includes(host.status_code) ? "This agent does not support automatic updates yet. Update the host agent to discover repositories." : host.error || "This host's agent is unavailable. Repositories will appear when it reconnects."}</p>}
          {host.available && host.enabled === false && <p className="git-updates-note">Rebuilding is disabled on this host. Enable REBUILD_ENABLED in its agent settings to allow automatic updates.</p>}
          {host.available && host.error && <p className="git-updates-error" role="alert">{host.error}</p>}
          {host.available && !host.projects?.length && <p className="git-updates-note">No repositories found. Run a Docker Compose project from a cloned Git repository on this host.</p>}
          {host.projects?.length > 0 && (
            <ul className="git-updates-projects">
              {host.projects.map((project) => {
                const key = `${host.host}/${project.id}`;
                return <Project key={project.id} host={host.host} project={project} demo={demo} saving={saving[key]} error={saveErrors[key]} stale={Boolean(error) || !host.available} onChange={(enabled) => select(host.host, project, enabled)} />;
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export default function GitUpdates({ demo = DEMO, machines = {} }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="git-updates">
      <button type="button" className={`git-updates-toggle ${open ? "expanded" : ""}`} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="host-toggle"><Icon name="chevron" size={14} /></span>
        <Icon name="refresh" size={15} />
        <strong>Automatic updates</strong>
        <span className="git-updates-summary">Push to Git · pull and rebuild</span>
      </button>
      <div id={bodyId}>{open && <GitUpdatesBody demo={demo} machines={machines} />}</div>
    </div>
  );
}
