import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/pihole — the dashboard's cached, read-only view of Pi-hole. The
// browser never talks to Pi-hole itself.

const DEMO_SNAPSHOT = {
  configured: true,
  reachable: true,
  stale: false,
  error: null,
  url: "http://192.168.1.11:8053",
  summary: { total: 4315, blocked: 363, percent_blocked: 8.4, active_clients: 17, gravity_domains: 72526 },
  blocking: { enabled: true, state: "enabled", timer: null },
  health: {
    uptime: 6385254,
    mem_percent: 0.2,
    cpu_percent: 0.2,
    versions: { core: "v6.4.3", web: "v6.6", ftl: "v6.7.1", docker: "2026.09.0" },
    update_available: [],
  },
  devices_total: 14,
  leases_total: 9,
};

export function fetchPihole() {
  if (DEMO) return Promise.resolve({ ...DEMO_SNAPSHOT, updated_at: Date.now() / 1000 - 20 });
  return fetch("/api/pihole").then(jsonOrThrow);
}

// One word for the card header: how far to trust the numbers below it.
export function piholeState(snapshot) {
  if (!snapshot || !snapshot.configured) return "unconfigured";
  if (!snapshot.reachable && !snapshot.updated_at) return "down";
  if (!snapshot.reachable) return "unreachable";
  if (snapshot.stale) return "stale";
  return "up";
}

// --- devices ---------------------------------------------------------------

const KINDS = ["server", "personal", "media", "iot", "unknown"];
const NOW = () => Date.now() / 1000;

const demoDevices = () => [
  { mac: "74:56:3c:98:7b:21", name: "bigboy", name_source: "static", label: "", kind: "server", kind_source: "static lease", notes: "", ip: "192.168.1.10", ip_type: "static-lease", vendor: "Giga-Byte", private_mac: false, online: true, first_seen: NOW() - 9e5, last_seen: NOW() - 30, queries_24h: 410, blocked_24h: 12, block_rate: 2.9, groups: [], ghost: "" },
  { mac: "5c:ff:35:08:84:ee", name: "thinkpad", name_source: "static", label: "", kind: "server", kind_source: "static lease", notes: "", ip: "192.168.1.11", ip_type: "static-lease", vendor: "", private_mac: false, online: null, first_seen: null, last_seen: null, queries_24h: null, blocked_24h: null, block_rate: null, groups: [], ghost: "" },
  { mac: "cc:08:fa:92:87:65", name: "MacBook Air", name_source: "pihole", label: "", kind: "personal", kind_source: "Pi-hole group", notes: "", ip: "192.168.1.47", ip_type: "dynamic", vendor: "Apple, Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 20, queries_24h: 1022, blocked_24h: 43, block_rate: 4.2, groups: ["personal"], ghost: "" },
  { mac: "a8:bb:56:63:4b:86", name: "iPhone 14", name_source: "pihole", label: "", kind: "personal", kind_source: "Pi-hole group", notes: "", ip: "192.168.1.7", ip_type: "dynamic", vendor: "Apple, Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 50, queries_24h: 1268, blocked_24h: 112, block_rate: 8.8, groups: ["personal"], ghost: "" },
  { mac: "44:d5:cc:49:b3:1c", name: "amazon-9e282eb2e", name_source: "hostname", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.23", ip_type: "dynamic", vendor: "Amazon Technologies Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 90, queries_24h: 110, blocked_24h: 9, block_rate: 8.2, groups: [], ghost: "" },
  { mac: "be:56:d7:90:93:f8", name: "be:56:d7:90:93:f8", name_source: "mac", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.42", ip_type: "dynamic", vendor: "", private_mac: true, online: false, first_seen: NOW() - 8e5, last_seen: NOW() - 7200, queries_24h: 111, blocked_24h: 11, block_rate: 9.9, groups: [], ghost: "" },
  { mac: "11:22:33:44:55:66", name: "gone", name_source: "hostname", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.99", ip_type: "dynamic", vendor: "", private_mac: false, online: false, first_seen: NOW() - 9e6, last_seen: NOW() - 9e5, queries_24h: null, blocked_24h: null, block_rate: null, groups: [], ghost: "stale" },
];

let demoState = null;

export function fetchDevices() {
  if (DEMO) {
    demoState = demoState || demoDevices();
    return Promise.resolve({ devices: demoState, kinds: KINDS, updated_at: NOW() - 40 });
  }
  return fetch("/api/pihole/devices").then(jsonOrThrow);
}

// Name, kind and notes for one device. Only the fields given change; blank ones clear.
export function saveDevice(mac, fields) {
  if (DEMO) {
    demoState = (demoState || demoDevices()).map((d) =>
      d.mac === mac
        ? {
            ...d,
            label: fields.name ?? d.label,
            name: fields.name || d.name,
            kind: fields.kind || d.kind,
            notes: fields.notes ?? d.notes,
          }
        : d
    );
    return Promise.resolve({ ok: true });
  }
  return fetch(`/api/pihole/devices/${encodeURIComponent(mac)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  }).then(jsonOrThrow);
}
