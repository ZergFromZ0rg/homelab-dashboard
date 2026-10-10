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

let demoBlocking = { enabled: true, state: "enabled", timer: null, until: null };

export function fetchPihole() {
  if (DEMO) {
    const timer = demoBlocking.until ? Math.max(0, Math.round(demoBlocking.until - Date.now() / 1000)) : null;
    const enabled = demoBlocking.enabled || (demoBlocking.until && timer === 0);
    return Promise.resolve({
      ...DEMO_SNAPSHOT,
      blocking: { enabled, state: enabled ? "enabled" : "disabled", timer: enabled ? null : timer },
      updated_at: Date.now() / 1000,
    });
  }
  return fetch("/api/pihole").then(jsonOrThrow);
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Pause blocking for `minutes` (null: until resumed), or turn it back on.
export function setBlocking(enabled, minutes = null) {
  if (DEMO) {
    demoBlocking = { enabled, until: !enabled && minutes ? Date.now() / 1000 + minutes * 60 : null };
    return fetchPihole();
  }
  return fetch("/api/pihole/blocking", json("POST", { enabled, minutes })).then(jsonOrThrow);
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
  { mac: "74:56:3c:98:7b:21", name: "bigboy", name_source: "static", label: "", kind: "server", kind_source: "static lease", notes: "", ip: "192.168.1.10", ip_type: "static-lease", vendor: "Giga-Byte", private_mac: false, online: true, first_seen: NOW() - 9e5, last_seen: NOW() - 30, queries_24h: 410, blocked_24h: 12, block_rate: 2.9, groups: [], group_ids: [0], ghost: "" },
  { mac: "5c:ff:35:08:84:ee", name: "thinkpad", name_source: "static", label: "", kind: "server", kind_source: "static lease", notes: "", ip: "192.168.1.11", ip_type: "static-lease", vendor: "", private_mac: false, online: null, first_seen: null, last_seen: null, queries_24h: null, blocked_24h: null, block_rate: null, groups: [], group_ids: [0], ghost: "" },
  { mac: "cc:08:fa:92:87:65", name: "MacBook Air", name_source: "pihole", label: "", kind: "personal", kind_source: "Pi-hole group", notes: "", ip: "192.168.1.47", ip_type: "dynamic", vendor: "Apple, Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 20, queries_24h: 1022, blocked_24h: 43, block_rate: 4.2, groups: ["personal"], group_ids: [3], ghost: "" },
  { mac: "a8:bb:56:63:4b:86", name: "iPhone 14", name_source: "pihole", label: "", kind: "personal", kind_source: "Pi-hole group", notes: "", ip: "192.168.1.7", ip_type: "dynamic", vendor: "Apple, Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 50, queries_24h: 1268, blocked_24h: 112, block_rate: 8.8, groups: ["personal"], group_ids: [3], ghost: "" },
  { new: true, mac: "44:d5:cc:49:b3:1c", name: "amazon-9e282eb2e", name_source: "hostname", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.23", ip_type: "dynamic", vendor: "Amazon Technologies Inc.", private_mac: false, online: true, first_seen: NOW() - 8e5, last_seen: NOW() - 90, queries_24h: 110, blocked_24h: 9, block_rate: 8.2, groups: [], group_ids: [0], ghost: "" },
  { mac: "be:56:d7:90:93:f8", name: "be:56:d7:90:93:f8", name_source: "mac", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.42", ip_type: "dynamic", vendor: "", private_mac: true, online: false, first_seen: NOW() - 8e5, last_seen: NOW() - 7200, queries_24h: 111, blocked_24h: 11, block_rate: 9.9, groups: [], group_ids: [0], ghost: "" },
  { mac: "11:22:33:44:55:66", name: "gone", name_source: "hostname", label: "", kind: "unknown", kind_source: "", notes: "", ip: "192.168.1.99", ip_type: "dynamic", vendor: "", private_mac: false, online: false, first_seen: NOW() - 9e6, last_seen: NOW() - 9e5, queries_24h: null, blocked_24h: null, block_rate: null, groups: [], group_ids: [0], ghost: "stale" },
];

const DEMO_GROUPS = [{ id: 0, name: "Default" }, { id: 1, name: "no-blocking" }, { id: 3, name: "personal" }];
let demoState = null;

export function fetchDevices() {
  if (DEMO) {
    demoState = demoState || demoDevices();
    return Promise.resolve({ devices: demoState, kinds: KINDS, groups: DEMO_GROUPS, updated_at: NOW() - 40 });
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

// --- one device ------------------------------------------------------------

const demoDetail = (mac) => {
  const t0 = NOW() - 144 * 600;
  return {
    device: (demoState || demoDevices()).find((d) => d.mac === mac),
    detail: {
      ip: "192.168.1.23",
      sample: 410,
      since: NOW() - 4700,
      blocked_sample: 36,
      series: Array.from({ length: 145 }, (_, i) => ({ t: t0 + i * 600, v: Math.round(8 + 6 * Math.sin(i / 9) + ((i * 7) % 5)) })),
      top_blocked: [
        { domain: "device-metrics-us.amazon.com", count: 14, allowable: true },
        { domain: "mads.amazon.com", count: 9, allowable: true },
        { domain: "mask.icloud.com", count: 7, allowable: false },
        { domain: "unagi-na.amazon.com", count: 6, allowable: true },
      ],
      top_domains: [{ domain: "api.amazonvideo.com", count: 88 }, { domain: "atv-ps.amazon.com", count: 61 }],
      recent: [
        { time: NOW() - 40, domain: "device-metrics-us.amazon.com", type: "A", status: "GRAVITY", blocked: true, allowable: true },
        { time: NOW() - 95, domain: "api.amazonvideo.com", type: "A", status: "FORWARDED", blocked: false },
        { time: NOW() - 130, domain: "mads.amazon.com", type: "A", status: "GRAVITY", blocked: true, allowable: true },
        { time: NOW() - 300, domain: "atv-ps.amazon.com", type: "AAAA", status: "CACHE", blocked: false },
      ],
    },
  };
};

export function fetchDeviceDetail(mac) {
  if (DEMO) return Promise.resolve(demoDetail(mac));
  return fetch(`/api/pihole/devices/${encodeURIComponent(mac)}`).then(jsonOrThrow);
}

export function setDeviceGroup(mac, group) {
  if (DEMO) {
    demoState = (demoState || demoDevices()).map((d) => (d.mac === mac ? { ...d, group_ids: [group] } : d));
    return Promise.resolve({ ok: true });
  }
  return fetch(`/api/pihole/devices/${encodeURIComponent(mac)}/group`, json("PUT", { group })).then(jsonOrThrow);
}

export function markKnown(mac) {
  if (DEMO) {
    demoState = (demoState || demoDevices()).map((d) => (d.mac === mac ? { ...d, new: false } : d));
    return Promise.resolve({ ok: true });
  }
  return fetch(`/api/pihole/devices/${encodeURIComponent(mac)}/known`, json("POST")).then(jsonOrThrow);
}

export function allowDomain(domain) {
  if (DEMO) return Promise.resolve({ ok: true, domain });
  return fetch("/api/pihole/allow", json("POST", { domain })).then(jsonOrThrow);
}

export function unallowDomain(domain) {
  if (DEMO) return Promise.resolve({ ok: true, domain });
  return fetch(`/api/pihole/allow/${encodeURIComponent(domain)}`, json("DELETE")).then(jsonOrThrow);
}

// Seconds of a pause left, counted down from when the dashboard last asked
// Pi-hole (`updated_at`); null when blocking is on or paused with no timer.
export function pauseRemaining(snapshot, nowSeconds = Date.now() / 1000) {
  const blocking = snapshot?.blocking;
  if (!blocking || blocking.enabled || blocking.timer == null) return null;
  return Math.max(0, Math.round(blocking.timer - (nowSeconds - (snapshot.updated_at || nowSeconds))));
}

export function formatCountdown(seconds) {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}:${s}`;
}
