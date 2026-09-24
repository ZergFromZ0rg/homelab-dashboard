import { tabColor } from "./tabColors";

// The four-across headline: is anything broken, are the machines up, are
// the containers up, and is your data safe. Numbers only — detail lives in
// the panels below.
//
// Backups replaced a second copy of the issue count, which said the same
// thing as System health right next to it. Before that the front page
// mentioned backups only when one broke, so the single most common
// question about them — "are they working?" — had no answer anywhere you
// would naturally look.

// `tone` is the color of the section the number belongs to (the tab it
// would take you to), so each tile reads as a different thing at a glance.
function Card({ label, value, sub, bad, tone }) {
  return (
    <div
      className={`summary-card ${bad ? "summary-card--bad" : ""}`}
      style={tone && !bad ? { "--tone": tone } : undefined}
    >
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      {sub && <span className="summary-sub">{sub}</span>}
    </div>
  );
}

function BackupCard({ backups }) {
  if (!backups || !backups.total) {
    return (
      <Card label="Backups" value="None" bad tone={tabColor("backups")} />
    );
  }

  const { total, ok, attention } = backups;

  // "5 / 7 OK" is the honest headline; how old each copy is lives on the
  // Backups tab.
  return (
    <Card
      label="Backups OK"
      value={`${ok} / ${total}`}
      bad={attention > 0}
      tone={tabColor("backups")}
    />
  );
}

function SummaryRow({ overview, machines, containers, backups }) {
  const hosts = Object.values(machines);
  const onlineHosts = hosts.filter((m) => m.online).length;

  const lists = Object.values(containers);
  const totalContainers = lists.reduce((n, l) => n + l.length, 0);
  const runningContainers = lists.reduce(
    (n, l) => n + l.filter((c) => c.status === "running").length,
    0
  );

  const issueCount = overview.issues.length;

  // Only the two "is something wrong" cards get the alarm treatment — the
  // Hosts / Containers ratios speak for themselves and a deliberately
  // stopped container shouldn't paint the card red.
  return (
    <div className="summary-row">
      <Card
        label="Health"
        value={overview.ok ? "All clear" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`}
        bad={!overview.ok}
        tone={overview.ok ? "var(--online)" : undefined}
      />
      <Card
        label="Hosts online"
        value={`${onlineHosts} / ${hosts.length || "—"}`}
        tone={tabColor("servers")}
      />
      <Card
        label="Containers up"
        value={`${runningContainers} / ${totalContainers || "—"}`}
        tone={tabColor("containers")}
      />
      <BackupCard backups={backups} />
    </div>
  );
}

export default SummaryRow;
