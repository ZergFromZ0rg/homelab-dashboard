// Common web-UI container ports. Used to pick the right one when a
// container publishes several (e.g. qbittorrent: 6881/tcp + 6881/udp for
// the torrent protocol, 8080/tcp for its web UI — plain alphabetical
// sorting of the keys would pick 6881 and open the wrong thing).
const COMMON_WEB_PORTS = new Set([
  80, 443, 3000, 3001, 5000, 8000, 8080, 8081, 8082, 8083, 8096, 8888, 9000,
  9090, 9091,
]);

export function firstHostPort(ports) {
  if (!ports) return null;

  const tcpKeys = Object.keys(ports)
    .filter((key) => key.endsWith("/tcp") && ports[key]?.length)
    .sort();

  if (tcpKeys.length === 0) return null;

  const preferred = tcpKeys.find((key) =>
    COMMON_WEB_PORTS.has(Number(key.split("/")[0]))
  );

  return ports[preferred || tcpKeys[0]][0];
}

export function containerUrl(host, ports) {
  const port = firstHostPort(ports);
  return port ? `http://${host}:${port}` : null;
}

// Where to send the browser for a container. The agent connects to each
// container's ports itself and says which one is a web UI, over which
// scheme, and at what path (`web`, or null when it has none). An agent
// that doesn't send the key (older, or hasn't probed yet) falls back to
// guessing from the published ports.
export function containerLink(host, container) {
  if (!container) return null;
  if (container.web !== undefined) {
    const web = container.web;
    if (!web) return null;
    const path = web.path && web.path !== "/" ? web.path : "";
    return `${web.scheme}://${host}:${web.port}${path}`;
  }
  return containerUrl(host, container.ports);
}

// Why a link may not work from a browser, or null. Only the agent can tell:
// it asks the way a browser will.
export function linkProblem(host, container) {
  const web = container?.web;
  if (!web || web.ok) return null;
  if (web.host_rejected) {
    return `Answers by address but refuses the name "${host}" — add it to the app's allowed hosts`;
  }
  return `Answered ${web.status}`;
}

// Letter-avatar tints. No green, red or amber: those mean up / down /
// warning everywhere else, and a red "N" beside a healthy container read
// as a problem. Shown as a tint behind a colored letter, not a solid block.
const AVATAR_COLORS = [
  "#5eead4", // teal
  "#7dd3fc", // sky
  "#a5b4fc", // periwinkle
  "#67e8f9", // cyan
  "#93c5fd", // light blue
  "#94a3b8", // slate
  "#e2c08d", // sand
  "#d4b896", // tan
];

export function avatarColor(name) {
  let hash = 0;

  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
