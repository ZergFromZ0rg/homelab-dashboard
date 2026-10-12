import { formatDuration } from "./format";

// Each drive's own verdict (SMART), read by the agent. Only a problem is
// spelled out; a healthy drive is one quiet line.
const HEALTH = { ok: "ok", warn: "warn", bad: "crit", unknown: "none" };

function tempTone(celsius) {
  if (celsius == null) return "none";
  if (celsius >= 65) return "crit";
  return celsius >= 55 ? "warn" : "ok";
}

// `wide` is a full-width table with temperature and power-on time; `list` is
// one two-line entry per drive, for a narrow column (the Storage page's side);
// without either, the compact table.
function DiskHealth({ health, wide = false, list = false }) {
  if (!health) return null;
  const disks = health.disks || [];
  if (list) {
    return (
      <>
        {health.error && <p className="gpu-limited">{health.error}</p>}
        {disks.map((d) => (
          <div className="dh-item" key={d.device} title={d.reasons?.join(" · ") || undefined}>
            <span className="dh-item-name">{d.model || d.device}</span>
            <span className={`sv-tone--${HEALTH[d.health] || "none"}`}>
              {d.health === "ok" ? "OK" : d.health === "unknown" ? "—" : d.reasons?.[0] || d.health}
              {d.standby && <span className="sv-dim"> · asleep</span>}
              {d.wear_percent != null && d.health === "ok" && <span className="sv-dim"> · {d.wear_percent}% worn</span>}
              {d.temperature_c != null && <span className={`sv-dim sv-tone--${tempTone(d.temperature_c)}`}> · {d.temperature_c}°C</span>}
            </span>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {health.error && <p className={wide ? "gpu-limited net-pad" : "gpu-limited"}>{health.error}</p>}
      {disks.length > 0 && wide && <div className="dh-head">Drive health</div>}
      {disks.length > 0 && (
        <table className={wide ? "net-table dh-table" : "sv-table sv-health"} title={health.checked_at ? `Checked ${new Date(health.checked_at * 1000).toLocaleString()}` : undefined}>
          <thead>
            <tr>
              <th>Drive</th>
              <th>Health</th>
              {wide && <th>Temp</th>}
              {wide && <th>Power on</th>}
            </tr>
          </thead>
          <tbody>
            {disks.map((d) => (
              <tr key={d.device} title={[d.reasons?.join(" · "), !wide && d.power_on_hours != null && `${formatDuration(d.power_on_hours * 3600)} powered on`].filter(Boolean).join(" — ") || undefined}>
                <td>
                  {d.model || d.device}
                  <span className="sv-dim"> {d.device}{d.kind ? ` · ${d.size_gb ? `${d.size_gb} GB ` : ""}${d.kind.toUpperCase()}` : ""}</span>
                </td>
                <td className={`sv-tone--${HEALTH[d.health] || "none"}`}>
                  {d.health === "ok" ? "OK" : d.health === "unknown" ? "—" : d.reasons?.[0] || d.health}
                  {d.standby && <span className="sv-dim"> · asleep</span>}
                  {d.wear_percent != null && d.health === "ok" && <span className="sv-dim"> · {d.wear_percent}% worn</span>}
                  {!wide && d.temperature_c != null && <span className={`sv-dim sv-tone--${tempTone(d.temperature_c)}`}> · {d.temperature_c}°C</span>}
                </td>
                {wide && <td className={`sv-tone--${tempTone(d.temperature_c)}`}>{d.temperature_c != null ? `${d.temperature_c}°C` : "—"}</td>}
                {wide && <td>{d.power_on_hours != null ? formatDuration(d.power_on_hours * 3600) : "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default DiskHealth;
