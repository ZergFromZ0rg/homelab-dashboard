import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/lan/{host}/scan — a sweep of the LAN that host is on. Start it, then
// poll: devices show up as the agent finds them. 502 / 400 carry a reason
// (agent too old, no private network to scan).

const url = (host) => `/api/lan/${encodeURIComponent(host)}/scan`;

// A canned scan for /?demo: devices appear over a few seconds.
const DEMO_DEVICES = [
  { ip: "192.168.1.1", mac: "f0:9f:c2:11:aa:01", hostname: "router.lan", ports: [{ port: 80, service: "http" }, { port: 443, service: "https" }, { port: 53, service: "dns" }] },
  { ip: "192.168.1.10", mac: "d8:5e:d3:42:10:10", hostname: "bigboy.lan", ports: [{ port: 22, service: "ssh" }, { port: 8096, service: "jellyfin" }, { port: 8123, service: "agent" }], via: "self" },
  { ip: "192.168.1.11", mac: "00:e0:4c:68:00:11", hostname: "thinkpad.lan", ports: [{ port: 22, service: "ssh" }, { port: 8081, service: "http" }] },
  { ip: "192.168.1.20", mac: "b8:27:eb:9a:20:20", hostname: "pihole.lan", ports: [{ port: 80, service: "http" }, { port: 53, service: "dns" }] },
  { ip: "192.168.1.31", mac: "3c:22:fb:7c:31:31", hostname: null, ports: [{ port: 62078, service: "ios" }] },
  { ip: "192.168.1.42", mac: "a4:83:e7:0d:42:42", hostname: "printer.lan", ports: [{ port: 631, service: "ipp" }, { port: 9100, service: "printer" }] },
  { ip: "192.168.1.58", mac: "7c:2f:80:91:58:58", hostname: null, ports: [] },
  { ip: "192.168.1.77", mac: "de:ad:be:ef:77:77", hostname: null, ports: [] },
];
let demoStart = null;

function demoScan() {
  if (demoStart == null) return { state: "idle", devices: [] };
  const t = (Date.now() - demoStart) / 1000;
  const done = t > 6;
  const shown = Math.min(DEMO_DEVICES.length, Math.floor(t * 1.6));
  return {
    state: done ? "done" : "scanning",
    phase: done ? "done" : t > 4 ? "ports" : "sweeping",
    subnet: "192.168.1.0/24",
    iface: "eth0",
    own_ip: "192.168.1.10",
    total: 254,
    scanned: done ? 254 : Math.min(254, Math.floor(t * 55)),
    devices: DEMO_DEVICES.slice(0, done ? DEMO_DEVICES.length : shown),
    started_at: demoStart / 1000,
    finished_at: done ? demoStart / 1000 + 6 : null,
    error: null,
  };
}

export function fetchScan(host) {
  if (DEMO) return Promise.resolve(demoScan());
  return fetch(url(host)).then(jsonOrThrow);
}

export function startScan(host) {
  if (DEMO) {
    demoStart = Date.now();
    return Promise.resolve(demoScan());
  }
  return fetch(url(host), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then(jsonOrThrow);
}

// Every node's own LAN addresses ({host: [{iface, ip, mac}]}), to mark the
// devices in a scan that are the dashboard's own nodes.
export function fetchNodeAddresses() {
  if (DEMO) {
    return Promise.resolve({
      nodes: {
        bigboy: [{ iface: "eth0", ip: "192.168.1.10", mac: "d8:5e:d3:42:10:10" }],
        thinkpad: [{ iface: "enp0s25", ip: "192.168.1.11", mac: "00:e0:4c:68:00:11" }],
      },
    });
  }
  return fetch("/api/lan-nodes").then(jsonOrThrow);
}
