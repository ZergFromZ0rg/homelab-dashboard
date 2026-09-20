import HostGrid from "./HostGrid";

function Fact({ label, value, sub, bad }) {
  return (
    <div className={`fact ${bad ? "fact--bad" : ""}`}>
      <span className="fact-label">{label}</span>
      <strong className="fact-value">{value}</strong>
      {sub && <span className="fact-sub">{sub}</span>}
    </div>
  );
}

// Every machine in full: gauges + history, network, GPUs, disks, and what
// runs on it. The Overview only has the one-glance version of this.
function ServersTab({ machines, containers, history, mainHost, connected }) {
  const names = Object.keys(machines);
  const online = names.filter((n) => machines[n].online).length;
  // Hosts that have a backup set up at all, and how many of those are fine.
  const backupStates = names
    .map((n) => machines[n].backup?.state)
    .filter((s) => ["ok", "stale", "failing", "pending"].includes(s));
  const backupsOk = backupStates.filter((s) => s === "ok" || s === "pending").length;
  const backupsBad = backupStates.length - backupsOk;
  const lists = Object.values(containers);
  const total = lists.reduce((n, l) => n + l.length, 0);
  const running = lists.reduce(
    (n, l) => n + l.filter((c) => c.status === "running").length,
    0
  );
  const cores = names.reduce((n, name) => n + (machines[name].cpu_cores || 0), 0);

  if (names.length === 0) {
    return (
      <div className="empty-state">
        {connected === false ? "Connecting…" : "No servers reporting yet."}
      </div>
    );
  }

  return (
    <section className="servers-tab">
      <div className="facts-row">
        <Fact
          label="Servers online"
          value={`${online} / ${names.length}`}
          bad={online < names.length}
        />
        <Fact label="Containers" value={`${running} / ${total}`} sub="running" />
        <Fact label="CPU threads" value={cores || "—"} sub="across the fleet" />
        <Fact
          label="Backups"
          value={backupStates.length ? `${backupsOk} / ${backupStates.length}` : "—"}
          sub={backupStates.length ? "healthy" : "none configured"}
          bad={backupsBad > 0}
        />
      </div>

      <HostGrid
        machines={machines}
        containers={containers}
        history={history}
        mainHost={mainHost}
      />
    </section>
  );
}

export default ServersTab;
