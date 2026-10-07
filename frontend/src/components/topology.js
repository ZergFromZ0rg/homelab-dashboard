// What a LAN scan looks like as a map: a device's kind (from its vendor,
// name and open ports) and where it sits. Pure functions, no React.
//
// A scan can't see the switch or access-point wiring (that needs SNMP or
// LLDP on the gear), so the map is honest about what it knows: every device
// answered on the same subnet, behind the router. Kinds are a best guess
// from the vendor and ports and are only used to group and label.

export const KINDS = {
  node: "Your servers",
  router: "Router",
  network: "Network gear",
  server: "Servers",
  computer: "Computers",
  phone: "Phones & tablets",
  media: "Media & TV",
  printer: "Printers",
  iot: "Smart devices",
  unknown: "Other",
};

// Angular order around the router, so like devices sit together.
const ORDER = ["router", "network", "node", "server", "computer", "media", "printer", "iot", "phone", "unknown"];

const has = (text, re) => re.test(text || "");
const hasPort = (d, ...ports) => (d.ports || []).some((p) => ports.includes(p.port));
const hasService = (d, ...names) => (d.ports || []).some((p) => names.includes(p.service));

export const ipKey = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

export function classify(d, { gateway = null } = {}) {
  const vendor = d.vendor || "";
  const name = d.hostname || "";
  if (d.node) return "node";
  if (gateway && d.ip === gateway) return "router";
  if (has(name, /^(router|gateway|modem)\b/i)) return "router";
  if (hasPort(d, 631, 9100) || has(vendor, /canon|epson|brother|xerox|lexmark|kyocera/i)) return "printer";
  if (hasPort(d, 8096, 32400) || has(vendor, /roku|sonos|vizio|tcl|chromecast/i)) return "media";
  if (has(vendor, /espressif|tuya|shelly|sonoff|ring|nest|ecobee|philips lighting|signify|wyze|xiaomi.*(iot|home)/i)) return "iot";
  if (hasPort(d, 62078) || has(vendor, /samsung|oneplus|huawei|oppo|motorola|xiaomi|google/i)) return "phone";
  if (d.randomized) return "phone";
  if (has(vendor, /ubiquiti|tp-?link|netgear|mikrotik|cisco|linksys|d-link|eero|aruba|zyxel|asus/i)) return "network";
  if (has(vendor, /raspberry/i) || hasService(d, "ssh", "mysql", "postgres", "nfs", "mqtt", "jellyfin", "plex", "sonarr")) return "server";
  if (hasService(d, "rdp", "smb", "netbios", "afp") || has(vendor, /apple|intel|dell|lenovo|microsoft|giga-?byte|realtek|msi|asrock|hewlett/i)) return "computer";
  if (hasService(d, "http", "https", "dns")) return "server";
  return "unknown";
}

// Short label under a node: the name's first label, else the last two octets.
export function shortName(d) {
  if (d.node) return d.node;
  if (d.hostname) return d.hostname.split(".")[0];
  return d.ip.split(".").slice(-2).join(".");
}

const INNER = 150;
const RING = 105;
const PER_RING = 14;
const GAP = 24; // degrees left open at the top for the Internet link

// Positions around (0, 0), where the router sits. Your own nodes (and the
// gear that carries the network) take the inner ring; everything else fills
// outer rings of at most PER_RING devices each. Returns {x, y} by key, plus
// the outermost radius, so the caller can size its viewBox.
export function layout(devices) {
  const sorted = [...devices].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || ipKey(a.ip) - ipKey(b.ip)
  );
  const inner = sorted.filter((d) => d.kind === "node" || d.kind === "network");
  const rest = sorted.filter((d) => d.kind !== "node" && d.kind !== "network");
  const rings = [inner];
  for (let i = 0; i < rest.length; i += PER_RING) rings.push(rest.slice(i, i + PER_RING));
  if (inner.length === 0) rings.shift();

  const positions = new Map();
  let radius = 0;
  rings.forEach((ring, r) => {
    radius = INNER + r * RING;
    const span = 360 - GAP * 2;
    ring.forEach((d, i) => {
      // Offset alternate rings so spokes to the router don't line up.
      const step = span / Math.max(ring.length, 1);
      const angle = -90 + GAP + step * (i + (r % 2 ? 0.25 : 0.5));
      const rad = (angle * Math.PI) / 180;
      positions.set(d.key, { x: Math.cos(rad) * radius, y: Math.sin(rad) * radius, ring: r });
    });
  });
  return { positions, radius: radius || INNER };
}
