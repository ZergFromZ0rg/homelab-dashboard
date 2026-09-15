import Sparkline from "./Sparkline";
import Gauge from "./Gauge";
import Stat from "./Stat";
import { diskLabel } from "./diskLabel";
import { formatBytes, formatBytesPerSec as formatSpeed } from "./format";
import { windowPoints } from "./historyWindow";
import { useSettings } from "./settings";

// Reference ceiling for the CPU temperature gauge ring — not a real limit,
// just a "how close to uncomfortably hot" scale so the ring fills
// proportionally instead of needing its own 0-100 metric.
const CPU_TEMP_GAUGE_MAX = 90;

function formatUptime(seconds) {
  if (seconds == null) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);

  return `${days}d ${hours}h`;
}

function MachineVitals({ machine, history }) {
  const {
    settings: { graphWindowMinutes: windowMinutes },
  } = useSettings();

  const netMax = Math.max(
    1,
    ...windowPoints(history?.network_rx, windowMinutes).map((p) => p.v ?? 0),
    ...windowPoints(history?.network_tx, windowMinutes).map((p) => p.v ?? 0)
  ) * 1.15;

  return (
    <>
      {machine.cpu_model && (
        <div className="cpu-model" title={machine.cpu_model}>
          {machine.cpu_model}
        </div>
      )}

      <div className="gauge-row">
        <div className="gauge-stat">
          <Gauge value={machine.cpu} size={48} strokeWidth={5} />
          <div className="gauge-stat-info">
            <span>
              CPU
              {machine.cpu_physical_cores != null &&
              machine.cpu_cores != null &&
              machine.cpu_physical_cores !== machine.cpu_cores
                ? ` · ${machine.cpu_physical_cores}c/${machine.cpu_cores}t`
                : machine.cpu_cores != null
                ? ` · ${machine.cpu_cores}t`
                : ""}
            </span>
            <Sparkline
              points={history?.cpu}
              max={100}
              variant="cpu"
              height={30}
              showAxis
              windowMinutes={windowMinutes}
            />
          </div>
        </div>

        <div className="gauge-stat">
          <Gauge
            value={
              machine.temperature != null
                ? (machine.temperature / CPU_TEMP_GAUGE_MAX) * 100
                : null
            }
            label={machine.temperature != null ? `${machine.temperature}°` : "—"}
            size={48}
            strokeWidth={5}
          />
          <div className="gauge-stat-info">
            <span>CPU TEMP</span>
            <Sparkline
              points={history?.temperature}
              variant="cpu"
              height={30}
              showAxis
              windowMinutes={windowMinutes}
            />
          </div>
        </div>

        <div className="gauge-stat">
          <Gauge value={machine.ram} size={48} strokeWidth={5} />
          <div className="gauge-stat-info">
            <span>
              RAM
              {machine.ram_total_bytes != null
                ? ` · ${formatBytes(machine.ram_total_bytes)}`
                : ""}
            </span>
            <Sparkline
              points={history?.ram}
              max={100}
              variant="ram"
              height={30}
              showAxis
              windowMinutes={windowMinutes}
            />
          </div>
        </div>

        <div className="compact-stats">
          <span>
            LOAD <strong>{machine.load1 ?? "—"}</strong>
          </span>
          <span>
            UPTIME <strong>{formatUptime(machine.uptime)}</strong>
          </span>
        </div>
      </div>

      <div className="network-stats">
        <Stat label="DOWNLOAD" value={`↓ ${formatSpeed(machine.network_rx)}`}>
          <Sparkline
            points={history?.network_rx}
            max={netMax}
            variant="rx"
            windowMinutes={windowMinutes}
          />
        </Stat>

        <Stat label="UPLOAD" value={`↑ ${formatSpeed(machine.network_tx)}`}>
          <Sparkline
            points={history?.network_tx}
            max={netMax}
            variant="tx"
            windowMinutes={windowMinutes}
          />
        </Stat>
      </div>

      {machine.gpu?.available !== false &&
        (machine.gpu?.devices?.length || machine.gpu) &&
        (() => {
          const devices = machine.gpu.devices?.length
            ? machine.gpu.devices
            : [machine.gpu];

          // Agents that can't reach NVML report a name like
          // "NVIDIA GPU 10DE:2187" — split the trailing PCI id onto its
          // own muted line instead of letting it wrap mid-name.
          const pciMatch = (name) =>
            (name || "").match(/^(.*?)[\s(]*([0-9a-f]{4}:[0-9a-f]{4})\)?$/i);

          return devices.map((gpu, index) => {
            const match = pciMatch(gpu.name);
            const gpuName = (match?.[1] || gpu.name || "Detected GPU").trim();
            const pciId = match?.[2];
            // History is only sampled for the first device (see
            // backend/live_history.py) — later devices get stats but no
            // sparkline.
            const showHistory = index === 0;

            return (
              <div className="gpu-stats" key={gpu.device_id ?? index}>
                <Stat
                  label={`GPU${devices.length > 1 ? ` ${index + 1}/${devices.length}` : ""}${
                    machine.agent_stale_age != null ? " · stale" : ""
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
                    value={`${gpu.power_draw_w ?? "—"} / ${
                      gpu.power_limit_w ?? "—"
                    } W`}
                  />
                )}

                {gpu.fan_percent != null && (
                  <Stat label="FAN" value={`${gpu.fan_percent}%`} />
                )}
              </div>
            );
          });
        })()}

      {machine.disk_io?.length > 0 && (
        <div className="disk-io-list">
          {machine.disk_io.map((disk) => (
            <div className="disk-io-row" key={disk.device}>
              <strong>{disk.name}</strong>
              <span>↓ {formatSpeed(disk.read_bps)}</span>
              <span>↑ {formatSpeed(disk.write_bps)}</span>
            </div>
          ))}
        </div>
      )}

      {machine.filesystems?.length > 0 && (
        <div className="storage-section">
          <span className="storage-title">STORAGE</span>

          {machine.filesystems.map((filesystem) => (
            <div
              className="disk"
              key={`${filesystem.device}-${filesystem.mountpoint}`}
            >
              <div className="disk-header">
                <div>
                  <strong>{diskLabel(filesystem)}</strong>
                  <span>{filesystem.mountpoint}</span>
                </div>

                <strong>
                  {filesystem.used_percent}%
                  {filesystem.free_bytes != null && (
                    <small> · {formatBytes(filesystem.free_bytes)} free</small>
                  )}
                </strong>
              </div>

              <div className="disk-bar">
                <div
                  className="disk-bar-fill"
                  style={{
                    width: `${Math.min(filesystem.used_percent, 100)}%`,
                  }}
                />
              </div>

              <div className="disk-details">
                <span>{formatBytes(filesystem.used_bytes)} used</span>
                <span>{formatBytes(filesystem.total_bytes)} total</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default MachineVitals;
