export const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "cpu", label: "CPU usage" },
  { value: "ram", label: "RAM usage" },
  { value: "status", label: "Status" },
  { value: "uptime", label: "Uptime (longest)" },
  { value: "uptime_short", label: "Uptime (newest)" },
];

// When a running container started, in ms; null for one that isn't running
// (Docker reports a zero "0001-01-01" time for a never-started one), so
// those always sort last whichever way uptime is ordered.
function startedMs(container) {
  if (container.status !== "running") return null;
  const value = container.started_at;
  if (!value || value.startsWith("0001-")) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function byUptime(longestFirst) {
  return (a, b) => {
    const x = startedMs(a);
    const y = startedMs(b);
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    return longestFirst ? x - y : y - x;
  };
}

// A container is "needs attention" when its healthcheck is failing or it's
// been restarting a lot — these float to the top of a host group (ahead of
// the chosen sort, behind pins) and get a red marker. The restart
// threshold is user-configurable (Settings → Containers); this is only the
// fallback for a caller that doesn't pass one.
export const HIGH_RESTART_COUNT = 5;

export function needsAttention(container, restartThreshold = HIGH_RESTART_COUNT) {
  return (
    container.health === "unhealthy" ||
    (container.restart_count ?? 0) >= restartThreshold
  );
}

export function sortContainers(containers, sortBy) {
  const list = [...containers];

  switch (sortBy) {
    case "cpu":
      return list.sort(
        (a, b) => (b.stats?.cpu_percent ?? -1) - (a.stats?.cpu_percent ?? -1)
      );

    case "ram":
      return list.sort(
        (a, b) =>
          (b.stats?.memory?.used_bytes ?? -1) -
          (a.stats?.memory?.used_bytes ?? -1)
      );

    case "status":
      return list.sort((a, b) => {
        if (a.status === b.status) return a.name.localeCompare(b.name);
        if (a.status === "running") return -1;
        if (b.status === "running") return 1;
        return a.status.localeCompare(b.status);
      });

    case "uptime":
      return list.sort(byUptime(true));

    case "uptime_short":
      return list.sort(byUptime(false));

    case "name":
    default:
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}
