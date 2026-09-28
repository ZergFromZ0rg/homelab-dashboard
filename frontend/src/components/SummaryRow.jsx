import FleetUpdate from "./FleetUpdate";

// The headline numbers on one thin line: is anything broken, are the
// machines and containers up, are the agents current, is your data safe.
// Only the "something is wrong" numbers get color.
function Item({ label, value, tone, title }) {
  return (
    <span className={`stat-item ${tone ? `stat-item--${tone}` : ""}`} title={title}>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function SummaryRow({ overview, machines, containers, backups, agents = false }) {
  const hosts = Object.values(machines);
  const onlineHosts = hosts.filter((m) => m.online).length;
  const lists = Object.values(containers);
  const total = lists.reduce((n, l) => n + l.length, 0);
  const running = lists.reduce((n, l) => n + l.filter((c) => c.status === "running").length, 0);
  const cores = hosts.reduce((n, m) => n + (m.cpu_cores || 0), 0);
  const issues = overview.issues.length;

  return (
    <div className="stat-strip">
      <Item
        label="Health"
        value={overview.ok ? "all clear" : `${issues} issue${issues === 1 ? "" : "s"}`}
        tone={overview.ok ? "ok" : "bad"}
      />
      <Item label="Hosts" value={`${onlineHosts}/${hosts.length || "—"}`} tone={onlineHosts < hosts.length ? "bad" : null} title="online" />
      <Item label="Containers" value={`${running}/${total || "—"}`} title="running" />
      {cores > 0 && <Item label="Threads" value={cores} title="CPU threads across the fleet" />}
      <Item
        label="Backups"
        value={backups?.total ? `${backups.ok}/${backups.total}` : "none"}
        tone={!backups?.total || backups.attention ? "bad" : null}
        title="backup jobs healthy"
      />
      {agents && <FleetUpdate machines={machines} />}
    </div>
  );
}

export default SummaryRow;
