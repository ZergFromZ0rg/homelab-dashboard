import HostRecovery from "./HostRecovery";
import HostSettings from "./HostSettings";
import Sparkline from "./Sparkline";
import Stat from "./Stat";
import { diskLabel } from "./diskLabel";
import {
  formatBytes,
  formatBytesPerSec as formatSpeed,
  formatDaysUntilFull,
} from "./format";
import { windowPoints } from "./historyWindow";
import { useSettings } from "./settings";

// Show a fill forecast once it's within a month; colour it as it gets close
// (same lines the Attention rules use: 7 days warns, ~2 days is critical).
const FORECAST_SHOW_DAYS = 30;

function forecastTone(days) {
  if (days <= 2) return "bad";
  if (days <= 7) return "warn";
  return "none";
}

// Matches ALERT_DISK_PERCENT / ALERT_DISK_CRITICAL_PERCENT, so a bar turns
// the colour it will alert at.
function diskTone(usedPercent) {
  if (usedPercent >= 97) return "bad";
  if (usedPercent >= 90) return "warn";
  return "ok";
}

// "6m" / "3h 20m" / "7d 22h". A host that rebooted an hour ago used to
// read "0d 1h", which buried the one thing worth noticing about it.
function formatUptime(seconds) {
  if (seconds == null) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Under an hour means it rebooted while you weren't looking.
const RECENT_BOOT_SECONDS = 3600;

// Agents that can't reach NVML report a name like "NVIDIA GPU 10DE:2187" —
// split the trailing PCI id onto its own muted line instead of letting it
// wrap mid-name.
function pciMatch(name) {
  return (name || "").match(/^(.*?)[\s(]*([0-9a-f]{4}:[0-9a-f]{4})\)?$/i);
}

// A host reports GPUs as {available, count, devices: [...]}; a couple of
// call sites in older data (or tests) pass the single-device shape
// directly as `machine.gpu` — normalize both to an array.
function gpuDevices(machine) {
  if (machine.gpu?.available === false) return [];
  if (machine.gpu?.devices?.length) return machine.gpu.devices;
  return machine.gpu ? [machine.gpu] : [];
}

function GpuDevice({ gpu, index, total, stale, history, windowMinutes }) {
  const match = pciMatch(gpu.name);
  const gpuName = (match?.[1] || gpu.name || "Detected GPU").trim();
  const pciId = match?.[2];
  // History is only sampled for the first device (see
  // backend/live_history.py) — later devices get stats but no sparkline.
  const showHistory = index === 0;

  return (
    <div className="gpu-stats">
      <Stat
        label={`GPU${total > 1 ? ` ${index + 1}/${total}` : ""}${
          stale ? " · stale" : ""
        }`}
        value={gpuName}
      >
        {pciId && <small>{pciId.toUpperCase()}</small>}
        {gpu.vendor && <small>{gpu.vendor.toUpperCase()}</small>}
      </Stat>

      {gpu.utilization_percent != null && (
        <Stat label="UTILIZATION" value={`${gpu.utilization_percent}%`} />
      )}

      {(gpu.memory_used_mb != null || gpu.memory_total_mb != null) && (
        <Stat
          label="VRAM"
          value={`${gpu.memory_used_mb ?? "—"} / ${
            gpu.memory_total_mb ?? "—"
          } MB`}
        />
      )}

      {gpu.temperature_c != null && (
        <Stat label="GPU TEMP" value={`${gpu.temperature_c}°C`}>
          {showHistory && (
            <Sparkline
              points={history?.gpu_temperature}
              variant="cpu"
              windowMinutes={windowMinutes}
            />
          )}
        </Stat>
      )}

      {(gpu.power_draw_w != null || gpu.power_limit_w != null) && (
        <Stat
          label="POWER"
          value={`${gpu.power_draw_w ?? "—"} / ${gpu.power_limit_w ?? "—"} W`}
        />
      )}

      {gpu.fan_percent != null && <Stat label="FAN" value={`${gpu.fan_percent}%`} />}
    </div>
  );
}

function pct(value) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

// 11560 -> "11.6k"
function compact(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function level(value, warn = 70, crit = 90) {
  if (value == null) return "none";
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function Bar({ value, tone }) {
  return (
    <span className={`sv-bar sv-bar--${tone || level(value)}`}>
      <span style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
    </span>
  );
}

// A label / value list, two columns. `rows` is [[label, value, title?]];
// rows whose value is undefined are skipped, so a metric this host's
// exporter doesn't have just isn't listed.
function KV({ rows }) {
  return (
    <dl className="sv-kv">
      {rows
        .filter(([, value]) => value !== undefined)
        .map(([label, value, title]) => (
          <div key={label} title={title}>
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
    </dl>
  );
}

function Section({ title, aside, children }) {
  return (
    <section className="sv-section">
      <h3>
        {title}
        {aside != null && <span>{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

// A number with its trend underneath.
function Trend({ label, value, tone, children }) {
  return (
    <div className="sv-trend">
      <div className="sv-trend-head">
        <span>{label}</span>
        <strong className={tone ? `sv-tone--${tone}` : undefined}>{value}</strong>
      </div>
      {children}
    </div>
  );
}

const MODE_ORDER = ["user", "system", "iowait", "steal", "irq", "softirq", "nice"];

// Where CPU time goes, as one stacked bar and its legend. Idle is the gap.
function CpuModes({ modes }) {
  const shown = MODE_ORDER.filter((m) => modes[m] != null);
  return (
    <div className="sv-modes">
      <span className="sv-modes-bar">
        {shown.map((m) => (
          <span
            key={m}
            className={`sv-mode sv-mode--${m}`}
            style={{ width: `${Math.min(100, modes[m])}%` }}
            title={`${m} ${modes[m]}%`}
          />
        ))}
      </span>
      <span className="sv-modes-legend">
        {shown.map((m) => (
          <span key={m}>
            <i className={`sv-mode sv-mode--${m}`} />
            {m} <b>{modes[m]}%</b>
          </span>
        ))}
      </span>
    </div>
  );
}

function PerCore({ cores }) {
  return (
    <div className="sv-cores">
      {cores.map((v, i) => (
        <span key={i} className={`sv-core sv-core--${level(v)}`} title={`core ${i}: ${v}%`}>
          <span className="sv-core-fill" style={{ height: `${Math.min(100, v)}%` }} />
          <span className="sv-core-label">{i}</span>
        </span>
      ))}
    </div>
  );
}

// Everything known about one server, laid out as five dense sections:
// CPU, memory, storage, network & system, thermals & GPU. Every metric the
// agent and node_exporter report is on screen — this is the tab for detail.
function MachineVitals({ host, machine, history }) {
  const {
    settings: { graphWindowMinutes: windowMinutes },
  } = useSettings();

  const d = machine.details || {};
  const netMax = Math.max(
    1,
    ...windowPoints(history?.network_rx, windowMinutes).map((p) => p.v ?? 0),
    ...windowPoints(history?.network_tx, windowMinutes).map((p) => p.v ?? 0)
  ) * 1.15;

  const gpus = gpuDevices(machine);
  const filesystems = machine.filesystems || [];
  const cores =
    machine.cpu_physical_cores != null &&
    machine.cpu_cores != null &&
    machine.cpu_physical_cores !== machine.cpu_cores
      ? `${machine.cpu_physical_cores} cores / ${machine.cpu_cores} threads`
      : machine.cpu_cores != null
        ? `${machine.cpu_cores} threads`
        : undefined;

  const memUsed =
    d.mem_total != null && d.mem_available != null ? d.mem_total - d.mem_available : undefined;
  const swapUsed =
    d.swap_total != null && d.swap_free != null ? d.swap_total - d.swap_free : undefined;
  const swapPct = d.swap_total ? (swapUsed / d.swap_total) * 100 : null;
  const recentBoot = machine.uptime != null && machine.uptime < RECENT_BOOT_SECONDS;

  return (
    <>
      <div className="sv-identity">
        {d.os && <span>{d.os}</span>}
        {d.kernel && <span>kernel {d.kernel}</span>}
        {d.arch && <span>{d.arch}</span>}
        {machine.cpu_model && <span>{machine.cpu_model}</span>}
        <span className={recentBoot ? "compact-stat--fresh" : undefined}>
          up {formatUptime(machine.uptime)}
        </span>
      </div>

      <div className="sv-grid">
        <Section title="CPU" aside={cores}>
          <Trend label="Usage" value={pct(machine.cpu)} tone={level(machine.cpu)}>
            <Sparkline points={history?.cpu} max={100} variant="cpu" height={34} windowMinutes={windowMinutes} />
          </Trend>
          {d.cpu_modes && <CpuModes modes={d.cpu_modes} />}
          {d.per_core?.length > 0 && <PerCore cores={d.per_core} />}
          <KV
            rows={[
              ["Load 1 / 5 / 15", `${machine.load1 ?? "—"} / ${d.load5 ?? "—"} / ${d.load15 ?? "—"}`],
              ["Clock", d.cpu_mhz != null ? `${(d.cpu_mhz / 1000).toFixed(2)} GHz` : undefined,
                d.cpu_mhz_max != null ? `fastest core ${(d.cpu_mhz_max / 1000).toFixed(2)} GHz` : undefined],
              ["Waiting on CPU", d.pressure_cpu != null ? `${d.pressure_cpu}%` : undefined,
                "Pressure stall: share of time a task was ready but had to wait for a CPU"],
            ]}
          />
        </Section>

        <Section
          title="Memory"
          aside={machine.ram_total_bytes != null ? formatBytes(machine.ram_total_bytes) : undefined}
        >
          <Trend label="Used" value={pct(machine.ram)} tone={level(machine.ram, 80, 90)}>
            <Sparkline points={history?.ram} max={100} variant="ram" height={34} windowMinutes={windowMinutes} />
          </Trend>
          <KV
            rows={[
              ["Used", memUsed !== undefined ? formatBytes(memUsed) : undefined],
              ["Available", d.mem_available !== undefined ? formatBytes(d.mem_available) : undefined],
              ["Cached", d.mem_cached !== undefined ? formatBytes(d.mem_cached) : undefined],
              ["Buffers", d.mem_buffers !== undefined ? formatBytes(d.mem_buffers) : undefined],
              ["Free", d.mem_free !== undefined ? formatBytes(d.mem_free) : undefined],
              ["Dirty", d.mem_dirty !== undefined ? formatBytes(d.mem_dirty) : undefined,
                "Written in memory, not yet flushed to disk"],
              ["Waiting on memory", d.pressure_memory != null ? `${d.pressure_memory}%` : undefined],
            ]}
          />
          {d.swap_total != null && (
            <div className="sv-swap">
              <div className="sv-row-head">
                <span>Swap</span>
                <span>
                  {d.swap_total ? `${formatBytes(swapUsed)} / ${formatBytes(d.swap_total)}` : "none"}
                </span>
              </div>
              {d.swap_total > 0 && <Bar value={swapPct} />}
            </div>
          )}
        </Section>

        <Section
          title="Storage"
          aside={d.pressure_io != null ? `waiting on IO ${d.pressure_io}%` : undefined}
        >
          {filesystems.map((fs) => {
            const inodes = d.inodes_used?.[fs.mountpoint];
            const forecast =
              fs.days_until_full != null && fs.days_until_full <= FORECAST_SHOW_DAYS
                ? formatDaysUntilFull(fs.days_until_full)
                : null;
            return (
              <div className="sv-disk" key={`${fs.device}-${fs.mountpoint}`}>
                <div className="sv-row-head">
                  <span title={fs.device}>
                    <strong>{diskLabel(fs)}</strong> <span className="sv-dim">{fs.mountpoint}</span>
                  </span>
                  <span className={`sv-tone--${diskTone(fs.used_percent)}`}>{fs.used_percent}%</span>
                </div>
                <Bar
                  value={fs.used_percent}
                  tone={{ ok: "ok", warn: "warn", bad: "crit" }[diskTone(fs.used_percent)]}
                />
                <div className="sv-row-foot">
                  <span>
                    {formatBytes(fs.used_bytes)} of {formatBytes(fs.total_bytes)}
                  </span>
                  <span>{formatBytes(fs.free_bytes)} free</span>
                  {inodes != null && <span title="inodes used">inodes {inodes}%</span>}
                  {forecast && (
                    <span className={`disk-forecast disk-forecast--${forecastTone(fs.days_until_full)}`}>
                      {forecast}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {machine.disk_io?.length > 0 && (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>Disk</th>
                  <th>Read</th>
                  <th>Write</th>
                  <th>Busy</th>
                </tr>
              </thead>
              <tbody>
                {machine.disk_io.map((disk) => {
                  const busy = d.disk_busy?.[disk.device];
                  return (
                    <tr key={disk.device}>
                      <td>{disk.name}</td>
                      <td>{formatSpeed(disk.read_bps)}</td>
                      <td>{formatSpeed(disk.write_bps)}</td>
                      <td className={`sv-tone--${level(busy, 60, 90)}`}>{busy != null ? `${busy}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Network & system">
          <div className="sv-pair">
            <Trend label="Down" value={formatSpeed(machine.network_rx)}>
              <Sparkline points={history?.network_rx} max={netMax} variant="rx" height={28} windowMinutes={windowMinutes} />
            </Trend>
            <Trend label="Up" value={formatSpeed(machine.network_tx)}>
              <Sparkline points={history?.network_tx} max={netMax} variant="tx" height={28} windowMinutes={windowMinutes} />
            </Trend>
          </div>

          {machine.interfaces?.length > 0 && (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>Interface</th>
                  <th>Down</th>
                  <th>Up</th>
                </tr>
              </thead>
              <tbody>
                {machine.interfaces.map((iface) => (
                  <tr key={iface.device} title={iface.in_total === false ? "Overlay link, not counted in the totals above" : undefined}>
                    <td>
                      {iface.name}
                      {iface.in_total === false && <span className="sv-dim"> overlay</span>}
                    </td>
                    <td>{formatSpeed(iface.rx_bps)}</td>
                    <td>{formatSpeed(iface.tx_bps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <KV
            rows={[
              ["TCP connections", d.tcp_established !== undefined ? compact(d.tcp_established) : undefined,
                d.tcp_time_wait != null ? `${d.tcp_time_wait} in TIME_WAIT` : undefined],
              ["Sockets", d.sockets_used !== undefined ? compact(d.sockets_used) : undefined],
              ["Errors / drops",
                d.net_rx_errs_per_s !== undefined
                  ? `${(d.net_rx_errs_per_s + (d.net_tx_errs_per_s ?? 0)).toFixed(1)} / ${((d.net_rx_drop_per_s ?? 0) + (d.net_tx_drop_per_s ?? 0)).toFixed(1)} per s`
                  : undefined],
              ["Processes", d.procs_running !== undefined ? `${d.procs_running} running · ${d.procs_blocked ?? 0} blocked` : undefined],
              ["Forks", d.forks_per_s !== undefined ? `${d.forks_per_s}/s` : undefined],
              ["Context switches", d.ctx_switches_per_s !== undefined ? `${compact(d.ctx_switches_per_s)}/s` : undefined],
              ["Interrupts", d.interrupts_per_s !== undefined ? `${compact(d.interrupts_per_s)}/s` : undefined],
              ["Open files", d.fds_open !== undefined
                ? `${compact(d.fds_open)}${d.fds_max && d.fds_max < 1e12 ? ` of ${compact(d.fds_max)}` : ""}`
                : undefined],
              ["Entropy", d.entropy_bits !== undefined ? `${d.entropy_bits} bits` : undefined],
            ]}
          />
        </Section>

        <Section title="Thermals & GPU">
          <Trend
            label="CPU temperature"
            value={machine.temperature != null ? `${machine.temperature}°C` : "—"}
            tone={level(machine.temperature, 75, 85)}
          >
            <Sparkline points={history?.temperature} variant="cpu" height={28} windowMinutes={windowMinutes} />
          </Trend>

          {d.sensors?.length > 0 && (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th />
                  <th>°C</th>
                </tr>
              </thead>
              <tbody>
                {d.sensors.map((s, i) => (
                  <tr key={`${s.chip}-${s.sensor}-${i}`}>
                    <td>{s.chip}</td>
                    <td className="sv-dim">{s.sensor}</td>
                    <td className={`sv-tone--${level(s.celsius, 75, 85)}`}>{s.celsius}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {gpus.map((gpu, index, devices) => (
            <GpuDevice
              key={gpu.device_id ?? index}
              gpu={gpu}
              index={index}
              total={devices.length}
              stale={machine.agent_stale_age != null}
              history={history}
              windowMinutes={windowMinutes}
            />
          ))}

          {/* The agent found a card it can't read properly. Without this the
              only symptom is a GPU block with every number missing, which
              reads like an idle card rather than a misconfigured one. */}
          {machine.gpu?.hint && <p className="gpu-hint">{machine.gpu.hint}</p>}
          {!gpus.length && !machine.gpu?.hint && <p className="sv-dim">No GPU.</p>}
        </Section>
      </div>

      {host && (
        <div className="sv-manage">
          <HostSettings host={host} />
          <HostRecovery host={host} />
        </div>
      )}
    </>
  );
}

export default MachineVitals;
