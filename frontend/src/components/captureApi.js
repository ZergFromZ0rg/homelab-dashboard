import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/capture/{host} — a live packet capture on that host. Start it, then
// poll with the number of the last packet you have so each answer carries
// only what is new. 502 / 400 carry a reason (agent too old, one already
// running, a bad filter).

const url = (host, tail = "") => `/api/capture/${encodeURIComponent(host)}${tail}`;
const post = (host, body, tail = "") =>
  fetch(url(host, tail), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow);

export const pcapUrl = (host) => url(host, "/pcap");

// --- /?demo: a made-up capture that fills in over its duration -------------

const toHex = (text) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const REQUEST = "GET /library/index.html HTTP/1.1\r\nHost: nas.lan\r\nAccept: */*\r\n\r\n";
const RESPONSE = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 38\r\n\r\n<html><body>Hello from nas</body></html>";
const HTTP_FLOW = "TCP|192.168.1.11|40818|192.168.1.20|80";

// [proto, src, sport, dst, dport, service, info, extras]
const DEMO_FLOWS = [
  ["TCP", "192.168.1.31", 51522, "192.168.1.10", 8096, "jellyfin", "51522 → 8096 [A] win 501"],
  ["TCP", "192.168.1.10", 41022, "140.82.121.4", 443, "https", "41022 → 443 [PA] win 64240"],
  ["TCP", "192.168.1.31", 52311, "104.18.32.7", 443, "https", "Client Hello → api.github.com", { sni: "api.github.com", app: "tls" }],
  ["TCP", "192.168.1.11", 40818, "192.168.1.20", 80, "http", "GET /library/index.html  Host: nas.lan", {
    app: "http", name: "nas.lan", flow: HTTP_FLOW, flags: "PA", seq: 101, plen: REQUEST.length, payload: REQUEST,
  }],
  ["TCP", "192.168.1.20", 80, "192.168.1.11", 40818, "http", "HTTP 200 OK", {
    app: "http", flow: HTTP_FLOW, flags: "PA", seq: 5001, plen: RESPONSE.length, payload: RESPONSE,
  }],
  ["UDP", "192.168.1.58", 5353, "224.0.0.251", 5353, "mdns", "A _hap._tcp.local?"],
  ["UDP", "192.168.1.31", 49321, "192.168.1.1", 53, "dns", "A api.github.com?"],
  ["UDP", "192.168.1.1", 53, "192.168.1.31", 49321, "dns", "A api.github.com → 140.82.121.4"],
  ["UDP", "0.0.0.0", 68, "255.255.255.255", 67, "dhcp", "DHCP Request wants 192.168.1.58 \u201cesp-garage\u201d (7c:2f:80:91:58:58)", { app: "dhcp", name: "esp-garage" }],
  ["UDP", "192.168.1.10", 51000, "162.159.200.1", 123, "ntp", "NTP v4 client", { app: "ntp" }],
  ["TCP", "192.168.1.20", 22, "192.168.1.11", 50234, "ssh", "22 → 50234 [PA] win 501  [TCP retransmission]", { issues: ["retransmit"] }],
  ["TCP", "192.168.1.42", 9100, "192.168.1.11", 50990, "9100", "9100 → 50990 [R] win 0  [connection reset]", { issues: ["reset"] }],
  ["ICMP", "192.168.1.10", 0, "192.168.1.1", 0, null, "echo request"],
  ["ARP", "192.168.1.42", 0, "192.168.1.1", 0, null, "who has 192.168.1.1? tell 192.168.1.42"],
];
let demo = null;
let demoSaved = [];

function demoSnapshot(after = 0) {
  if (!demo) return { state: "idle" };
  const seconds = Math.min(demo.duration, (Date.now() - demo.startedAt) / 1000);
  const done = seconds >= demo.duration || demo.stopped;
  const count = Math.floor(seconds * 14);
  const packets = [];
  for (let n = after + 1; n <= count; n++) {
    const f = DEMO_FLOWS[n % DEMO_FLOWS.length];
    const extra = f[7] || {};
    const len = f[0] === "ARP" ? 42 : 60 + ((n * 37) % 1400);
    const headers = "aabbcc000002aabbcc00000108004500003c1c4640004006b1e6c0a8010ac0a8010100500050";
    const keepPayload = extra.payload && demo.payload === "full";
    packets.push({
      n, ts: demo.startedAt / 1000 + n / 14, len, iface: demo.iface, dir: n % 3 ? "in" : "out",
      proto: f[0], src: f[1], sport: f[2] || undefined, dst: f[3], dport: f[4] || undefined,
      svc: f[5], info: f[6], ttl: 64, l2: 14, ip: 4,
      ...extra, payload: undefined,
      hex: headers + (keepPayload ? toHex(extra.payload) : ""), poff: headers.length / 2,
    });
  }
  const bytes = count * 520;
  const series = Array.from({ length: Math.floor(seconds) }, (_, i) => ({
    ts: demo.startedAt / 1000 + i, pkts: 14, bytes: 5000 + ((i * 7919) % 9000),
  }));
  const protocols = {
    TCP: { pkts: Math.floor(count * 0.55), bytes: Math.floor(bytes * 0.8) },
    UDP: { pkts: Math.floor(count * 0.3), bytes: Math.floor(bytes * 0.17) },
    ICMP: { pkts: Math.floor(count * 0.08), bytes: Math.floor(bytes * 0.02) },
    ARP: { pkts: Math.floor(count * 0.07), bytes: Math.floor(bytes * 0.01) },
  };
  const flows = DEMO_FLOWS.map((f, i) => ({
    proto: f[0], a: f[1], a_port: f[2], b: f[3], b_port: f[4],
    pkts: Math.floor(count / DEMO_FLOWS.length), bytes: Math.floor((bytes * (15 - i)) / 120),
    out: 3, in: 5, name: (f[7] || {}).sni || (f[7] || {}).name || null,
    issues: (f[7] || {}).issues ? Object.fromEntries(f[7].issues.map((k) => [k, Math.floor(count / 30)])) : {},
    first: demo.startedAt / 1000, last: demo.startedAt / 1000 + seconds,
  }));
  const issues = { retransmit: Math.floor(count / 30), reset: Math.floor(count / 30) };
  return {
    state: demo.stopped ? "stopped" : done ? "done" : "capturing",
    iface: demo.iface, filter: demo.filter, payload: demo.payload, promisc: demo.promisc, duration: demo.duration,
    started_at: demo.startedAt / 1000, finished_at: done ? demo.startedAt / 1000 + seconds : null,
    error: null, totals: { pkts: count, bytes }, protocols, flows, series, packets, last: count, unlisted: 0,
    drops: count > 200 ? 3 : 0, issues,
  };
}

export function fetchCapture(host, after = 0) {
  if (DEMO) return Promise.resolve(demoSnapshot(after));
  return fetch(url(host) + `?after=${after}`).then(jsonOrThrow);
}

export function fetchCaptureInterfaces(host) {
  if (DEMO) return Promise.resolve({ default: "eth0", interfaces: ["eth0", "docker0", "tailscale0"] });
  return fetch(url(host, "/interfaces")).then(jsonOrThrow);
}

export function startCapture(host, options) {
  if (DEMO) {
    demo = {
      startedAt: Date.now(), duration: options.duration, iface: options.iface || "eth0",
      filter: options.filter || {}, payload: options.payload || "none", promisc: Boolean(options.promisc),
      stopped: false,
    };
    return Promise.resolve(demoSnapshot());
  }
  return post(host, options);
}

export function stopCapture(host) {
  if (DEMO) {
    if (demo) demo.stopped = true;
    return Promise.resolve(demoSnapshot());
  }
  return fetch(url(host), { method: "DELETE" }).then(jsonOrThrow);
}

// --- saved captures (kept on the dashboard) ----------------------------------

const saved = (tail = "") => `/api/captures${tail}`;
export const savedPcapUrl = (id) => saved(`/${encodeURIComponent(id)}/pcap`);

export function listSaved() {
  if (DEMO) return Promise.resolve({ captures: demoSaved.map((c) => c.meta) });
  return fetch(saved()).then(jsonOrThrow);
}

export function saveCapture(host, name) {
  if (DEMO) {
    const snap = demoSnapshot(0);
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const meta = {
      id, name: name || `${host} demo`, host, saved_at: Date.now() / 1000, iface: snap.iface, filter: snap.filter,
      payload: snap.payload, promisc: snap.promisc, packets: snap.packets.length, total_packets: snap.totals.pkts,
      bytes: snap.totals.bytes, drops: snap.drops, size: snap.packets.length * 400,
    };
    demoSaved = [{ meta, capture: snap }, ...demoSaved];
    return Promise.resolve(meta);
  }
  return post(host, { name }, "/save");
}

export function openSaved(id) {
  if (DEMO) return Promise.resolve(demoSaved.find((c) => c.meta.id === id));
  return fetch(saved(`/${encodeURIComponent(id)}`)).then(jsonOrThrow);
}

export function renameSaved(id, name) {
  if (DEMO) {
    const found = demoSaved.find((c) => c.meta.id === id);
    if (found) found.meta.name = name;
    return Promise.resolve(found?.meta);
  }
  return fetch(saved(`/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(jsonOrThrow);
}

export function deleteSaved(id) {
  if (DEMO) {
    demoSaved = demoSaved.filter((c) => c.meta.id !== id);
    return Promise.resolve({ deleted: true });
  }
  return fetch(saved(`/${encodeURIComponent(id)}`), { method: "DELETE" }).then(jsonOrThrow);
}
