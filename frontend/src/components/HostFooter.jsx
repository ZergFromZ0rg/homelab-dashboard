import { formatAge } from "./format";

// How a backup state reads on a host card. `null` = say nothing (an old
// agent, or we simply couldn't ask — not worth a chip).
function backupChip(backup) {
  switch (backup?.state) {
    case "ok":
      return { label: `backup ${formatAge(backup.last_success_age)}`, tone: "ok" };
    case "stale":
      return { label: `backup stale · ${formatAge(backup.last_success_age)}`, tone: "warn" };
    case "failing":
      return { label: "backup failing", tone: "bad", title: backup.last_error };
    case "pending":
      return { label: "backup pending", tone: "none" };
    case "not_configured":
      return { label: "no backup", tone: "none", title: "Set BACKUP_REPO and GITHUB_TOKEN on this host's homelab-agent" };
    default:
      return null;
  }
}

// Server-level facts that aren't host metrics: what runs on it and whether
// its agent is talking to us. Sits under a host's vitals.
function HostFooter({ machine, containers }) {
  const list = containers || [];
  const backup = backupChip(machine.backup);
  const running = list.filter((c) => c.status === "running").length;
  const unhealthy = list.filter((c) => c.health === "unhealthy").length;

  let agent = { label: "agent connected", tone: "ok" };
  if (machine.agent_reachable === false) {
    agent = { label: "agent unreachable", tone: "bad" };
  } else if (machine.agent_stale_age != null) {
    agent = { label: `agent stale ${machine.agent_stale_age}s`, tone: "warn" };
  } else if (machine.agent_reachable === undefined) {
    agent = { label: "no agent", tone: "none" };
  }

  return (
    <div className="host-foot">
      <span className="chip">
        {running}/{list.length} containers running
      </span>
      {unhealthy > 0 && <span className="chip chip--bad">{unhealthy} unhealthy</span>}
      <span className={`chip chip--${agent.tone}`}>{agent.label}</span>
      {backup && (
        <span className={`chip chip--${backup.tone}`} title={backup.title || undefined}>
          {backup.label}
        </span>
      )}
    </div>
  );
}

export default HostFooter;
