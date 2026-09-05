// Per-node headroom, shown above the deploy form so the placement the
// scheduler will pick is predictable at a glance. Same inputs the
// scheduler scores on (free RAM / free CPU / GPU / online).

function nodeRows(machines) {
  return Object.entries(machines ?? {})
    .map(([name, m]) => {
      const online = Boolean(m?.online);
      const cpu = typeof m?.cpu === "number" ? m.cpu : null;
      const ram = typeof m?.ram === "number" ? m.ram : null;
      const cores = typeof m?.cpu_cores === "number" ? m.cpu_cores : null;
      const ramTotal =
        typeof m?.ram_total_bytes === "number" ? m.ram_total_bytes : null;

      const freeCores = cores != null && cpu != null ? cores * (1 - cpu / 100) : null;
      const freeRamGb =
        ramTotal != null && ram != null
          ? (ramTotal * (1 - ram / 100)) / 1024 ** 3
          : null;
      const load = Math.max(cpu ?? 0, ram ?? 0);

      return {
        name,
        online,
        freeCores,
        freeRamGb,
        load,
        hasGpu: Boolean(m?.gpu?.devices?.length),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function FleetCapacity({ machines }) {
  const rows = nodeRows(machines);
  if (rows.length === 0) return null;

  return (
    <div className="fleet-capacity">
      <span className="deploy-label">Fleet capacity</span>
      {rows.map((r) => (
        <div
          key={r.name}
          className={`fleet-row ${r.online ? "" : "fleet-row--off"}`}
        >
          <span className="fleet-node">{r.name}</span>

          <div className="fleet-bar" title={`${r.load.toFixed(0)}% used`}>
            <div
              className={`fleet-bar-fill ${r.load >= 85 ? "fleet-bar-fill--hot" : ""}`}
              style={{ width: `${Math.min(100, Math.max(2, r.load))}%` }}
            />
          </div>

          <span className="fleet-free">
            {r.online
              ? `${r.freeRamGb != null ? `${r.freeRamGb.toFixed(1)} GB` : "—"} · ${
                  r.freeCores != null ? `${r.freeCores.toFixed(1)} cores` : "—"
                }`
              : "offline"}
          </span>

          {r.hasGpu && <span className="fleet-gpu">GPU</span>}
        </div>
      ))}
    </div>
  );
}

export default FleetCapacity;
