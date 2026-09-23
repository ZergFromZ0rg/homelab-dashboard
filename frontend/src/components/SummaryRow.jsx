import { formatAge } from "./format";

// The four-across headline: is anything broken, are the machines up, are
// the containers up, and is your data safe. Numbers only — detail lives in
// the panels below.
//
// Backups replaced a second copy of the issue count, which said the same
// thing as System health right next to it. Before that the front page
// mentioned backups only when one broke, so the single most common
// question about them — "are they working?" — had no answer anywhere you
// would naturally look.

function Card({ label, value, sub, bad }) {
  return (
    <div className={`summary-card ${bad ? "summary-card--bad" : ""}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      {sub && <span className="summary-sub">{sub}</span>}
    </div>
  );
}

function BackupCard({ backups }) {
  if (!backups || !backups.total) {
    return (
      <Card label="Backups" value="None" sub="nothing is backed up" bad />
    );
  }

  const { total, ok, attention, newest_success_age: age } = backups;

  // "5 / 7 healthy" is the honest headline; the age answers the question
  // people actually ask next, which is how old the newest copy is.
  return (
    <Card
      label="Backups"
      value={`${ok} / ${total}`}
      sub={
        attention
          ? `${attention} need${attention === 1 ? "s" : ""} attention`
          : age == null
            ? "not run yet"
            : `newest ${formatAge(age)}`
      }
      bad={attention > 0}
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
        label="System health"
        value={overview.ok ? "Operational" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`}
        sub={overview.ok ? "all clear" : "needs attention"}
        bad={!overview.ok}
      />
      <Card
        label="Hosts"
        value={`${onlineHosts} / ${hosts.length || "—"}`}
        sub="online"
      />
      <Card
        label="Containers"
        value={`${runningContainers} / ${totalContainers || "—"}`}
        sub="running"
      />
      <BackupCard backups={backups} />
    </div>
  );
}

export default SummaryRow;
