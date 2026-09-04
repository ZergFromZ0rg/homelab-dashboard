export const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "cpu", label: "CPU usage" },
  { value: "ram", label: "RAM usage" },
  { value: "status", label: "Status" },
];

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

    case "name":
    default:
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}
