// Shared display formatters. Byte formatting was copied verbatim into
// ContainerRow and MachineVitals.

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes) {
  if (bytes == null) return "—";

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit >= 3 ? 1 : 0)} ${UNITS[unit]}`;
}

export function formatBytesPerSec(bytesPerSecond) {
  if (bytesPerSecond == null) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

// "just now" / "42m ago" / "7h ago" / "3d ago" from an age in seconds.
export function formatAge(seconds) {
  if (seconds == null) return "—";

  const minutes = seconds / 60;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;

  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

// A disk-fill forecast in days -> "full in ~5 d" (or "<1 d"). Only worth
// showing when it's close; callers decide how close.
export function formatDaysUntilFull(days) {
  if (days == null) return null;
  return days < 1 ? "full in <1 d" : `full in ~${Math.round(days)} d`;
}

// A latency in ms -> "23 ms" / "1.4 s".
export function formatLatency(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// A span of seconds -> "45s" / "12m" / "3h" / "2d" (no "ago": "down for 12m").
export function formatDuration(seconds) {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
