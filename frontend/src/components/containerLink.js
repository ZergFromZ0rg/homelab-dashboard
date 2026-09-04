export function firstHostPort(ports) {
  if (!ports) return null;

  for (const key of Object.keys(ports).sort()) {
    const hostPorts = ports[key];

    if (hostPorts && hostPorts.length > 0) {
      return hostPorts[0];
    }
  }

  return null;
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
