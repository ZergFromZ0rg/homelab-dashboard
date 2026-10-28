import { formatAge, formatWhen } from "./format";

// The agent reports the age of its last backup, not its timestamp (its own
// clock is the honest one for "is this stale?"). For "which night was
// that?" the dashboard's clock is close enough, so the absolute time goes
// in the tooltip and the age stays on the chip.
function backupWhen(backup) {
  if (backup?.last_success_age == null) return undefined;
  return `Last backup ${formatWhen(Date.now() / 1000 - backup.last_success_age)}`;
}

// How a backup state reads on a host card. `null` = say nothing (an old
// agent, or we simply couldn't ask — not worth a chip).
function backupChip(backup) {
  switch (backup?.state) {
    case "ok":
      return {
        label: `backup ${formatAge(backup.last_success_age)}`,
        tone: "ok",
        title: backupWhen(backup),
      };
    case "stale":
      return {
        label: `backup stale · ${formatAge(backup.last_success_age)}`,
        tone: "warn",
        title: backupWhen(backup),
      };
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

// What the agent is running. "rebuild" means the checkout on that host has
// moved past the image — someone pulled without rebuilding, which is the
// state you can act on right now. "behind" means the remote has moved and
// a rebuild would pull it. Nothing at all for an agent too old to say.
function versionChip(version) {
  const short = version?.source?.short;

  switch (version?.state) {
    case "rebuild":
      return {
        label: "rebuild to apply",
        tone: "warn",
        title: `${short} is checked out on this host but the running agent was built before it`,
      };
    case "behind":
      return {
        label: "update available",
        tone: "warn",
        title: `the remote has moved past ${short}; a rebuild will pull it`,
      };
    case "current":
      return { label: `agent ${short}`, tone: "ok", title: "up to date" };
    case "unverified":
      // Saying "up to date" here would claim a check that never happened.
      return {
        label: `agent ${short}`,
        tone: "none",
        title:
          "couldn't reach the remote to check for updates — an ssh remote " +
          "needs keys the agent doesn't have, so switch it to https",
      };
    case "unsupported":
      return {
        label: "agent version unknown",
        tone: "none",
        title: "this agent predates version reporting — rebuild it once",
      };
    default:
      return null;
  }
}

// Server-level facts that aren't host metrics: a chip for anything about its OS,
// agent, backup or version that needs a look. Healthy states say nothing, and
// what runs on it and what failed are the band above the vitals. With nothing to
// say the footer isn't drawn.
function HostFooter({ machine, containers }) {
  const list = containers || [];
  const backup = backupChip(machine.backup);
  const version = versionChip(machine.agent_version);
  const outdated = list.filter((c) => c.update?.state === "available");
  const facts = machine.host_facts;

  let agent = { label: "agent connected", tone: "ok" };
  if (machine.agent_reachable === false) {
    agent = { label: "agent unreachable", tone: "bad" };
  } else if (machine.agent_stale_age != null) {
    agent = { label: `agent stale ${machine.agent_stale_age}s`, tone: "warn" };
  } else if (machine.agent_reachable === undefined) {
    agent = { label: "no agent", tone: "none" };
  }

  const chips = [
    facts?.upgrading && <span key="upgrading" className="chip chip--warn">upgrading OS…</span>,
    facts?.reboot_required && (
      <span key="reboot" className="chip chip--warn" title="Installed updates finish on the next reboot — System → Power">
        reboot needed
      </span>
    ),
    facts?.os_updates > 0 && (
      <span
        key="os"
        className={`chip ${facts.security_updates ? "chip--warn" : ""}`}
        title={`${facts.security_updates || 0} of them security fixes — System → OS updates`}
      >
        {facts.os_updates} OS update{facts.os_updates === 1 ? "" : "s"}
      </span>
    ),
    outdated.length > 0 && (
      <span key="images" className="chip" title={`Newer images: ${outdated.map((c) => c.name).join(", ")}`}>
        {outdated.length} update{outdated.length === 1 ? "" : "s"}
      </span>
    ),
    agent.tone !== "ok" && (
      <span key="agent" className={`chip chip--${agent.tone}`}>{agent.label}</span>
    ),
    backup && backup.tone !== "ok" && (
      <span key="backup" className={`chip chip--${backup.tone}`} title={backup.title || undefined}>
        {backup.label}
      </span>
    ),
    version && version.tone !== "ok" && (
      <span key="version" className={`chip chip--${version.tone}`} title={version.title}>
        {version.label}
      </span>
    ),
  ].filter(Boolean);

  if (chips.length === 0) return null;
  return <div className="host-foot">{chips}</div>;
}

export default HostFooter;
