import { useEffect, useState } from "react";
import { DEMO } from "../demoData";
import { getAuthStatus } from "./passkeyApi";
import { useLocalStorage } from "./useLocalStorage";

// "Finish setting up": what setup.sh can't do from a terminal, as a short
// checklist on Overview. Each line is read from real state — nothing is
// ticked by clicking it — and links to where it's done. The card leaves
// once everything is done, or when hidden (per browser).

function FirstRun({ machines, backups, onNavigate }) {
  const [hidden, setHidden] = useLocalStorage("homelab.firstRunHidden", false);
  const [auth, setAuth] = useState(DEMO ? { enabled: true } : null);

  useEffect(() => {
    if (DEMO || hidden) return;
    getAuthStatus().then(setAuth).catch(() => setAuth(null));
  }, [hidden]);

  const hosts = Object.values(machines);
  const steps = [
    {
      done: auth?.enabled,
      unknown: auth == null,
      text: "Add a passkey so the dashboard needs a sign-in",
      why: "Shells, file edits and compose changes are open to anyone who can reach this page until then.",
      action: "Settings",
      go: "settings",
    },
    {
      done: hosts.some((m) => m.cpu != null),
      text: "Connect Prometheus for CPU, memory and disk graphs",
      why: "Without it the servers show containers only. Set PROMETHEUS_URL on the dashboard and run node-exporter on each machine.",
      action: "Servers",
      go: "servers",
    },
    {
      done: hosts.filter((m) => m.agent_reachable !== undefined).length >= 2,
      text: "Add your other machines",
      why: "The Add a node command at the bottom of Servers installs the agent and joins it, locked with this dashboard's token.",
      action: "Servers",
      go: "servers",
    },
    {
      done: (backups?.total || 0) > 0,
      text: "Back up a volume or folder",
      why: "Scheduled, encrypted if you like, checked after every run.",
      action: "Backups",
      go: "backups",
    },
  ];

  const open = steps.filter((s) => !s.done && !s.unknown);
  if (hidden || open.length === 0) return null;

  return (
    <section className="overview-card first-run">
      <div className="overview-card-head">
        <h2>Finish setting up</h2>
        <span className="overview-card-count">{steps.filter((s) => s.done).length}/{steps.length}</span>
        <button type="button" className="first-run-hide" onClick={() => setHidden(true)} title="Hide this in this browser">
          Hide
        </button>
      </div>
      <ul className="first-run-list">
        {open.map((s) => (
          <li key={s.text} title={s.why}>
            <span className="first-run-dot" aria-hidden="true" />
            <span className="first-run-text">{s.text}</span>
            <button type="button" className="first-run-go" onClick={() => onNavigate(s.go)}>
              {s.action} →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FirstRun;
