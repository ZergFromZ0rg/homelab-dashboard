// Per-node headroom, shown above the deploy form so the placement the
// scheduler will pick is predictable at a glance. Same inputs the
// scheduler scores on (free RAM / free vCPU / GPU / online).
//
// "vCPU" = logical CPUs (threads) — the unit Docker's --cpus flag and the
// CPU utilisation % are both in. Physical core count is shown alongside
// when node_exporter reports it.

function nodeRows(machines) {
  return Object.entries(machines ?? {})
    .map(([name, m]) => {
      const online = Boolean(m?.online);
      const cpu = typeof m?.cpu === "number" ? m.cpu : null;
      const ram = typeof m?.ram === "number" ? m.ram : null;
      const vcpu = typeof m?.cpu_cores === "number" ? m.cpu_cores : null;
      const physCores =
        typeof m?.cpu_physical_cores === "number" ? m.cpu_physical_cores : null;
      const ramTotal =
        typeof m?.ram_total_bytes === "number" ? m.ram_total_bytes : null;

      const freeVcpu = vcpu != null && cpu != null ? vcpu * (1 - cpu / 100) : null;
      const freeRamGb =
        ramTotal != null && ram != null
          ? (ramTotal * (1 - ram / 100)) / 1024 ** 3
          : null;
      const load = Math.max(cpu ?? 0, ram ?? 0);

      return {
        name,
        online,
        vcpu,
        physCores,
        freeVcpu,
        freeRamGb,
        load,
        hasGpu: Boolean(m?.gpu?.devices?.length),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function commitment(machines, deployments) {
  let capRam = 0;
  let capVcpu = 0;
  for (const m of Object.values(machines ?? {})) {
    if (!m?.online) continue;
    if (typeof m.ram_total_bytes === "number") capRam += m.ram_total_bytes / 1024 ** 3;
    if (typeof m.cpu_cores === "number") capVcpu += m.cpu_cores;
  }
  let comRam = 0;
  let comVcpu = 0;
  for (const d of deployments ?? []) {
    if (d.status !== "running" && d.status !== "placing") continue;
    comRam += (d.spec?.resources?.memory_mb ?? 0) / 1024;
    comVcpu += d.spec?.resources?.cpus ?? 0;
  }
  return { capRam, capVcpu, comRam, comVcpu };
}

// "8c/16t" when both known, "16t" when only logical.
function cpuTag(r) {
  if (r.physCores != null && r.vcpu != null && r.physCores !== r.vcpu) {
    return `${r.physCores}c/${r.vcpu}t`;
  }
  if (r.vcpu != null) return `${r.vcpu}t`;
  return null;
}

function FleetCapacity({ machines, deployments }) {
  const rows = nodeRows(machines);
  if (rows.length === 0) return null;

  const { capRam, capVcpu, comRam, comVcpu } = commitment(machines, deployments);

  return (
    <div className="fleet-capacity">
      <span className="deploy-label">Fleet capacity</span>
      {rows.map((r) => (
        <div
          key={r.name}
          className={`fleet-row ${r.online ? "" : "fleet-row--off"}`}
        >
          <span className="fleet-node">
            {r.name}
            {cpuTag(r) && <span className="fleet-cpu-tag">{cpuTag(r)}</span>}
          </span>

          <div className="fleet-bar" title={`${r.load.toFixed(0)}% used`}>
            <div
              className={`fleet-bar-fill ${r.load >= 85 ? "fleet-bar-fill--hot" : ""}`}
              style={{ width: `${Math.min(100, Math.max(2, r.load))}%` }}
            />
          </div>

          <span className="fleet-free">
            {r.online
              ? `${r.freeRamGb != null ? `${r.freeRamGb.toFixed(1)} GB` : "—"} · ${
                  r.freeVcpu != null ? `${r.freeVcpu.toFixed(1)} vCPU` : "—"
                }`
              : "offline"}
          </span>

          {r.hasGpu && <span className="fleet-gpu">GPU</span>}
        </div>
      ))}

      {comRam + comVcpu > 0 && (
        <div className="fleet-committed">
          scheduler committed {comRam.toFixed(1)} GB · {comVcpu.toFixed(1)} vCPU
          {" of "}
          {capRam.toFixed(0)} GB · {capVcpu.toFixed(0)} vCPU online
        </div>
      )}
    </div>
  );
}

export default FleetCapacity;
