// Small readers over a machine snapshot, shared by the server card and
// the System tab.

// "6m" / "3h 20m" / "7d 22h". A host that rebooted an hour ago used to
// read "0d 1h", which buried the one thing worth noticing about it.
export function formatUptime(seconds) {
  if (seconds == null) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// A host reports GPUs as {available, count, devices: [...]}; a couple of
// call sites in older data (or tests) pass the single-device shape
// directly as `machine.gpu` — normalize both to an array.
export function gpuDevices(machine) {
  if (machine.gpu?.available === false) return [];
  if (machine.gpu?.devices?.length) return machine.gpu.devices;
  return machine.gpu ? [machine.gpu] : [];
}

