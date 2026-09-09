// The four-across headline: is anything broken, are the machines up, are
// the containers up, is there anything to do. Numbers only — detail lives
// in the panels below.

function Card({ label, value, sub, bad }) {
  return (
    <div className={`summary-card ${bad ? "summary-card--bad" : ""}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      {sub && <span className="summary-sub">{sub}</span>}
    </div>
  );
}

function SummaryRow({ overview, machines, containers }) {
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
      <Card
        label="Alerts"
        value={issueCount}
        sub={issueCount === 0 ? "no issues" : "to review"}
        bad={issueCount > 0}
      />
    </div>
  );
}

export default SummaryRow;
