import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/capture/{host} — a live packet capture on that host. Start it, then
// poll with the number of the last packet you have so each answer carries
// only what is new. 502 / 400 carry a reason (agent too old, one already
// running, a bad filter).

const url = (host, tail = "") => `/api/capture/${encodeURIComponent(host)}${tail}`;
const post = (host, body) =>
  fetch(url(host), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow);

export const pcapUrl = (host) => url(host, "/pcap");

// --- /?demo: a made-up capture that fills in over its duration -------------

const DEMO_FLOWS = [
  ["TCP", "192.168.1.31", 51522, "192.168.1.10", 8096, "jellyfin", "[A] win 501"],
  ["TCP", "192.168.1.10", 41022, "140.82.121.4", 443, "https", "[PA] win 64240"],
  ["TCP", "192.168.1.31", 52311, "104.18.32.7", 443, "https", "Client Hello → api.github.com", "api.github.com"],
  ["TCP", "192.168.1.11", 40818, "172.66.147.243", 443, "https", "Client Hello → jellyfin.example.com", "jellyfin.example.com"],
  ["UDP", "192.168.1.58", 5353, "224.0.0.251", 5353, "mdns", "A _hap._tcp.local?"],
  ["UDP", "192.168.1.31", 49321, "192.168.1.1", 53, "dns", "A api.github.com?"],
  ["UDP", "192.168.1.1", 53, "192.168.1.31", 49321, "dns", "A api.github.com → 140.82.121.4"],
  ["TCP", "192.168.1.20", 22, "192.168.1.11", 50234, "ssh", "[PA] win 501"],
  ["ICMP", "192.168.1.10", 0, "192.168.1.1", 0, null, "echo request"],
  ["ARP", "192.168.1.42", 0, "192.168.1.1", 0, null, "who has 192.168.1.1? tell 192.168.1.42"],
];
let demo = null;

function demoSnapshot(after = 0) {
  if (!demo) return { state: "idle" };
  const seconds = Math.min(demo.duration, (Date.now() - demo.startedAt) / 1000);
  const done = seconds >= demo.duration || demo.stopped;
  const count = Math.floor(seconds * 14);
  const packets = [];
  for (let n = after + 1; n <= count; n++) {
    const f = DEMO_FLOWS[n % DEMO_FLOWS.length];
    const len = f[0] === "ARP" ? 42 : 60 + ((n * 37) % 1400);
    packets.push({
      n, ts: demo.startedAt / 1000 + n / 14, len, iface: demo.iface, dir: n % 3 ? "in" : "out",
      proto: f[0], src: f[1], sport: f[2] || undefined, dst: f[3], dport: f[4] || undefined,
      svc: f[5], info: f[6], sni: f[7], app: f[7] ? "tls" : undefined, ttl: 64, l2: 14,
      hex: "aabbcc000002aabbcc00000108004500003c1c4640004006b1e6c0a8010ac0a8010100500050",
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
    pkts: Math.floor(count / DEMO_FLOWS.length), bytes: Math.floor((bytes * (9 - i)) / 45),
    out: 3, in: 5, name: f[7] || null, first: demo.startedAt / 1000, last: demo.startedAt / 1000 + seconds,
  }));
  return {
    state: demo.stopped ? "stopped" : done ? "done" : "capturing",
    iface: demo.iface, filter: demo.filter, payload: false, duration: demo.duration,
    started_at: demo.startedAt / 1000, finished_at: done ? demo.startedAt / 1000 + seconds : null,
    error: null, totals: { pkts: count, bytes }, protocols, flows, series, packets, last: count, unlisted: 0,
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
      filter: options.filter || {}, stopped: false,
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
