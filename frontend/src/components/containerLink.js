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

// Letter-avatar tints. No green, red or amber: those mean up / down /
// warning everywhere else, and a red "N" beside a healthy container read
// as a problem. Shown as a tint behind a colored letter, not a solid block.
const AVATAR_COLORS = [
  "#5eead4", // teal
  "#7dd3fc", // sky
  "#a5b4fc", // periwinkle
  "#c4b5fd", // violet
  "#f0abfc", // orchid
  "#f9a8d4", // pink
  "#94a3b8", // slate
  "#e2c08d", // sand
];

export function avatarColor(name) {
  let hash = 0;

  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
