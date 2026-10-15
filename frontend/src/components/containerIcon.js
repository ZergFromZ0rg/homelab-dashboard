import iconNames from "../dashboardIconNames";

// A container's logo, picked with no setup: its image ("lscr.io/linuxserver/
// sonarr:latest" -> sonarr) or its name is matched against the dashboard-icons
// set. Only exact matches count — a wrong logo is worse than the lettered
// avatar the caller falls back to.

const KNOWN = new Set(iconNames.split(/\s+/).filter(Boolean));

const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp";

// Image names that differ from the set's spelling.
const ALIASES = {
  pihole: "pi-hole",
  adguardhome: "adguard-home",
  homeassistant: "home-assistant",
  mongo: "mongodb",
  "qbittorrent-nox": "qbittorrent",
  "docker-registry": "docker",
  registry: "docker",
};

// Suffixes images add to the app's own name: "immich-server", "portainer-ce".
const SUFFIXES = ["-server", "-app", "-web", "-ui", "-ce", "-ee", "-oss", "-docker", "-nox", "-community"];

// "ghcr.io/immich-app/immich-server:v1.2@sha256:ab…" -> "immich-server"
function imageBase(image) {
  if (!image) return "";
  const noDigest = image.split("@")[0];
  const last = noDigest.split("/").pop() || "";
  return last.split(":")[0].toLowerCase();
}

// A compose service container is "<project>-<service>-<n>" or
// "<project>_<service>_<n>"; the replica number says nothing about the app.
function nameBase(name) {
  return (name || "").toLowerCase().replace(/[-_]\d+$/, "");
}

function variants(base) {
  const out = [base, base.replace(/_/g, "-")];
  for (const suffix of SUFFIXES) {
    if (base.endsWith(suffix)) out.push(base.slice(0, -suffix.length));
  }
  return out;
}

// Candidate logo names for a container, best first.
export function iconCandidates(container) {
  const bases = [imageBase(container?.image), nameBase(container?.name)].filter(Boolean);
  const found = [];
  for (const base of bases) {
    for (const v of variants(base)) {
      const name = ALIASES[v] ?? v;
      if (KNOWN.has(name) && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

// The logo's URL, or null when the set has none for this container.
export function containerIconUrl(container) {
  const [name] = iconCandidates(container);
  return name ? `${CDN}/${name}.webp` : null;
}
