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

const AVATAR_COLORS = [
  "#2dd4bf",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a78bfa",
  "#38bdf8",
  "#f472b6",
  "#84cc16",
];

export function avatarColor(name) {
  let hash = 0;

  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
