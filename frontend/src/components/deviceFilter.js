// Which devices the table shows. Pi-hole's own rows and long-gone devices are
// hidden by default (a count says how many); a search matches anything you'd
// recognise a device by.

export const FILTERS = [
  ["all", "All"],
  ["online", "Online"],
  ["server", "Servers"],
  ["unknown", "Unlabelled"],
];

const matches = (device, filter) => {
  if (filter === "online") return device.online === true;
  if (filter === "server") return device.kind === "server";
  if (filter === "unknown") return device.kind === "unknown";
  return true;
};

export function filterDevices(devices, { filter = "all", showHidden = false, query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return devices.filter((d) => {
    if (d.ghost && !showHidden) return false;
    if (!matches(d, filter)) return false;
    if (!q) return true;
    return [d.name, d.mac, d.ip, d.vendor, d.notes, d.kind].some((v) => (v || "").toLowerCase().includes(q));
  });
}

export const hiddenCount = (devices) => devices.filter((d) => d.ghost).length;
