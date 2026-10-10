import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/switch — the switch's ports as Prometheus last saw them. The browser
// never talks to the switch or to Prometheus. Traffic is from the device's
// side: "received" is what the switch sent it, "sent" what it sent the switch.

const demoPort = (index, name, over = {}) => ({
  index,
  name,
  port: `g${index}`,
  labelled: name !== `g${index}`,
  up: true,
  down_lately: false,
  seen_up: true,
  speed_mbps: 1000,
  usual_speed_mbps: 1000,
  sent_bps: 0,
  received_bps: 0,
  usage: 0,
  busy: 0,
  errors_24h: 0,
  errors_15m: 0,
  ...over,
});

const DEMO_SNAPSHOT = {
  state: "up",
  instance: "192.168.1.2",
  down_lately: false,
  reachable: true,
  stale: false,
  error: null,
  ports: [
    demoPort(1, "router", { speed_mbps: 100, usual_speed_mbps: 100, sent_bps: 1.9e6, received_bps: 11.4e6, usage: 0.114 }),
    demoPort(2, "bigboy", { sent_bps: 38e6, received_bps: 2.1e6, usage: 0.038, errors_24h: 3 }),
    demoPort(3, "thinkpad", { sent_bps: 0.4e6, received_bps: 1.2e6, usage: 0.001 }),
    demoPort(4, "g4", { sent_bps: 0.02e6, received_bps: 0.05e6 }),
    demoPort(5, "pi-hole", { up: false, speed_mbps: null, down_lately: true }),
  ],
};

export function fetchSwitch() {
  if (DEMO) return Promise.resolve({ ...DEMO_SNAPSHOT, updated_at: Date.now() / 1000 - 12 });
  return fetch("/api/switch").then(jsonOrThrow);
}

// Mbps with just enough digits: 0.4, 11, 940.
export function formatMbps(bps) {
  if (bps == null) return "—";
  const mbps = bps / 1e6;
  if (mbps < 0.05) return "0";
  if (mbps < 10) return mbps.toFixed(1);
  return Math.round(mbps).toLocaleString();
}

// 1000 -> "1G", 100 -> "100M", 2500 -> "2.5G".
export function formatLinkSpeed(mbps) {
  if (!mbps) return "—";
  return mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
}

// "bad" when a port runs below what it usually does (a cable going), "warn"
// when it is merely below gigabit (it may always have been), else "".
export function speedTone(port) {
  if (!port || !port.up || !port.speed_mbps) return "";
  if (port.usual_speed_mbps && port.speed_mbps < port.usual_speed_mbps) return "bad";
  return port.speed_mbps < 1000 ? "warn" : "";
}

export function speedHint(port) {
  if (!port || !port.up || !port.speed_mbps) return "No link";
  const tone = speedTone(port);
  if (tone === "bad") return `Linked at ${port.speed_mbps} Mbps; this port is usually ${port.usual_speed_mbps}. Check the cable.`;
  if (tone === "warn") return `Linked at ${port.speed_mbps} Mbps, below gigabit. Fine if the device is that slow; otherwise check the cable.`;
  return `Linked at ${port.speed_mbps} Mbps`;
}
