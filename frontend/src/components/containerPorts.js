import { containerLink, firstHostPort } from "./containerLink";

// Every host port the containers of one node hold, one row per port and
// protocol, lowest port first.
//
// Two sources, because Docker has two ways to claim a port:
//   * `ports` — what the container publishes (`-p 8080:80`), so the row also
//     knows the port inside.
//   * `listening` — the agent's list of TCP ports a host-network container
//     listens on. Such a container publishes nothing, so without this Pi-hole
//     (DNS on 53) would not be on the list at all. Absent from an older agent.
//
// A row carries `url` when it is the port the container's web UI is on, so
// the list can link to it the same way the container's name does.
export function portRows(host, containers) {
  const rows = [];

  for (const c of containers || []) {
    const link = containerLink(host, c);
    const webPort = c.web !== undefined ? c.web?.port : Number(firstHostPort(c.ports));
    const add = (port, proto, inside) => {
      if (!Number.isInteger(port) || port <= 0) return;
      rows.push({
        port,
        proto,
        inside,
        container: c.name,
        running: c.status === "running",
        hostNetwork: inside == null,
        url: link && proto === "tcp" && port === webPort ? link : null,
      });
    };

    for (const [key, bindings] of Object.entries(c.ports || {})) {
      const [inside, proto = "tcp"] = key.split("/");
      for (const binding of bindings || []) add(Number(binding), proto, inside);
    }
    for (const port of c.listening || []) add(Number(port), "tcp", null);
  }

  return rows.sort(
    (a, b) =>
      a.port - b.port ||
      a.proto.localeCompare(b.proto) ||
      a.container.localeCompare(b.container)
  );
}

// A search box that takes a container name or a port number.
export function matchesPort(row, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return (
    row.container.toLowerCase().includes(needle) ||
    String(row.port).startsWith(needle)
  );
}
