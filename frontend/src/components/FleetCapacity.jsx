// Per-node headroom, shown across the top of the Deploy tab so the placement the
// scheduler will pick is predictable at a glance. Same inputs the
// scheduler scores on (free RAM / free vCPU / GPU / online).
//
// "vCPU" = logical CPUs (threads) — the unit Docker's --cpus flag and the
// CPU utilisation % are both in. Physical core count is shown alongside
// when node_exporter reports it.

import { hostColor } from "./hostColor";

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

  // One row per node: what the scheduler scores on — free RAM, free vCPU,
  // how busy it is, whether it has a GPU.
  return (
    <section className="overview-card fleet-card">
      <div className="overview-card-head">
        <h2>Fleet capacity</h2>
        {comRam + comVcpu > 0 && (
          <span className="fleet-committed">
            scheduler has committed {comRam.toFixed(1)} GB · {comVcpu.toFixed(1)} vCPU of{" "}
            {capRam.toFixed(0)} GB · {capVcpu.toFixed(0)} vCPU online
          </span>
        )}
      </div>
      <table className="net-table fleet-table">
        <thead>
          <tr>
            <th>Node</th>
            <th>CPU</th>
            <th>Free RAM</th>
            <th>Free vCPU</th>
            <th>Busy</th>
            <th>GPU</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.online ? "" : "fleet-row--off"}>
              <td>
                <strong style={{ color: hostColor(r.name) }} className="fleet-name">
                  {r.name}
                </strong>
                {!r.online && <span className="net-dim"> offline</span>}
              </td>
              <td className="net-mono net-dim">{cpuTag(r) ?? "—"}</td>
              <td className="net-mono">
                {r.online && r.freeRamGb != null ? `${r.freeRamGb.toFixed(1)} GB` : "—"}
              </td>
              <td className="net-mono">
                {r.online && r.freeVcpu != null ? r.freeVcpu.toFixed(1) : "—"}
              </td>
              <td className="fleet-busy">
                <span className={`sv-bar sv-bar--${r.load >= 90 ? "crit" : r.load >= 70 ? "warn" : "ok"}`}>
                  <span style={{ width: `${Math.min(100, Math.max(2, r.load))}%` }} />
                </span>
                <span className="net-mono">{Math.round(r.load)}%</span>
              </td>
              <td>{r.hasGpu ? <span className="chip">GPU</span> : <span className="net-dim">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default FleetCapacity;
