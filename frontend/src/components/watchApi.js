import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/netwatch/{host} — the opt-in watch for ARP spoofing, address clashes and
// rogue DHCP servers; /api/autocapture — the capture the dashboard takes by
// itself when a service check goes down. Errors carry a reason (agent too old,
// a capture already running).

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// --- /?demo ------------------------------------------------------------------------------

const NOW = () => Date.now() / 1000;
const demoWatch = { enabled: false };
let demoAuto = { enabled: false, duration: 20, per_host_per_hour: 4, keep: 10 };

function demoSnapshot() {
  if (!demoWatch.enabled) {
    return { enabled: false, state: "off", findings: [], active: [], devices: 0, dhcp_servers: [], learning: false };
  }
  const t = NOW();
  const findings = [
    {
      id: "g1", kind: "gateway-changed", severity: "bad", at: t - 1800, last: t - 1700, count: 2,
      title: "The gateway's address changed hands",
      message: "Your gateway 192.168.1.1 is now answered by de:ad:be:ef:00:01; it was f0:9f:c2:11:aa:01. If you replaced or reset the router that is expected; otherwise something on the network is impersonating it (ARP spoofing).",
      hint: "Check which device has that MAC (Network → Scans). If you didn't change the router, treat this as an attack.",
      ip: "192.168.1.1", mac: "de:ad:be:ef:00:01", previous: "f0:9f:c2:11:aa:01",
    },
    {
      id: "d1", kind: "second-dhcp-server", severity: "warn", at: t - 7200, last: t - 7200, count: 1,
      title: "Another DHCP server is answering: 192.168.1.77",
      message: "192.168.1.77 (b8:27:eb:9a:20:20) offered a lease; 192.168.1.1 (f0:9f:c2:11:aa:01) has been answering until now.",
      ip: "192.168.1.77", mac: "b8:27:eb:9a:20:20",
    },
    {
      id: "n1", kind: "new-device", severity: "info", at: t - 600, last: t - 600, count: 1,
      title: "New device 192.168.1.58", message: "7c:2f:80:91:58:58 appeared on the network and claimed 192.168.1.58.",
      ip: "192.168.1.58", mac: "7c:2f:80:91:58:58",
    },
  ];
  return {
    enabled: true, state: "watching", iface: "eth0", since: t - 86400, beat: t - 4, learning: false, devices: 14,
    gateway: "192.168.1.1", dhcp_servers: [{ ip: "192.168.1.1", mac: "f0:9f:c2:11:aa:01", first: t - 86400, last: t - 900 }],
    findings, active: findings.filter((f) => f.severity !== "info" && t - f.last < 3600),
  };
}

// --- api ----------------------------------------------------------------------------------

export function fetchWatch(host) {
  if (DEMO) return Promise.resolve(demoSnapshot());
  return fetch(`/api/netwatch/${encodeURIComponent(host)}`).then(jsonOrThrow);
}

export function setWatch(host, enabled) {
  if (DEMO) {
    demoWatch.enabled = enabled;
    return Promise.resolve(demoSnapshot());
  }
  return fetch(`/api/netwatch/${encodeURIComponent(host)}`, json("POST", { enabled })).then(jsonOrThrow);
}

export function fetchAutoCapture() {
  if (DEMO) return Promise.resolve(demoAuto);
  return fetch("/api/autocapture").then(jsonOrThrow);
}

export function saveAutoCapture(changes) {
  if (DEMO) {
    demoAuto = { ...demoAuto, ...changes };
    return Promise.resolve(demoAuto);
  }
  return fetch("/api/autocapture", json("PUT", changes)).then(jsonOrThrow);
}

export function tryAutoCapture(host) {
  if (DEMO) return Promise.resolve({ name: `auto: manual test (${new Date().toTimeString().slice(0, 5)})`, host, packets: 212 });
  return fetch(`/api/autocapture/${encodeURIComponent(host)}/test`, { method: "POST" }).then(jsonOrThrow);
}
