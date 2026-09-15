// Consistent color per host name, so the same host reads as the same
// color everywhere it shows up — Containers tab host groups, the pin
// chip, Quick Actions, node cards in System Stats. Makes scanning a busy
// list faster once you've learned "blue = bigboy".
//
// A deliberately different palette (and hash) from containerLink.js's
// avatarColor() — host identity and container identity are two
// different signals on the same row, so they must never collide. Also
// deliberately excludes green/red/amber: those already mean
// online/offline/warning throughout the app, and a host badge in "warning
// orange" would misread as a status, not an identity.
const HOST_COLORS = [
  "#60a5fa", // blue
  "#c084fc", // purple
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#818cf8", // indigo
  "#e879f9", // fuchsia
];

export function hostColor(host) {
  let hash = 0;
  const name = host || "";
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return HOST_COLORS[Math.abs(hash) % HOST_COLORS.length];
}
