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
