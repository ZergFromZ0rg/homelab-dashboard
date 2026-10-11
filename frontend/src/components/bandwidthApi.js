import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";
import { formatBytes } from "./format";

// /api/bandwidth — the switch's ports as devices: what each is moving now, over
// the last two hours, and in the last 24. "down" is to the device, "up" from it.
// Everything behind the router is the router's own row (`uplink`), not split.

// Two hours of one-minute points, shaped like the real trend ({t, v} in bits/s).
function demoTrend(base, wobble, seed) {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 120 }, (_, i) => ({
    t: now - (119 - i) * 60,
    v: Math.max(0, base + Math.sin((i + seed) / 7) * wobble + Math.cos((i * seed) / 11) * wobble * 0.4),
  }));
}

const demoDevice = (index, name, over = {}) => ({
  index,
  name,
  port: `g${index}`,
  labelled: true,
  up: true,
  speed_mbps: 1000,
  uplink: false,
  down_bps: 0,
  up_bps: 0,
  down_24h: 0,
  up_24h: 0,
  down_trend: [],
  up_trend: [],
  ...over,
});

const DEMO_SNAPSHOT = {
  state: "up",
  reachable: true,
  devices: [
    demoDevice(1, "router", {
      speed_mbps: 100,
      uplink: true,
      down_bps: 21.4e6,
      up_bps: 3.9e6,
      down_24h: 61e9,
      up_24h: 9.2e9,
      down_trend: demoTrend(18e6, 9e6, 3),
      up_trend: demoTrend(3e6, 1.5e6, 5),
    }),
    demoDevice(2, "bigboy", {
      down_bps: 2.1e6,
      up_bps: 38e6,
      down_24h: 14e9,
      up_24h: 205e9,
      down_trend: demoTrend(2e6, 1e6, 2),
      up_trend: demoTrend(36e6, 14e6, 7),
    }),
    demoDevice(3, "thinkpad", {
      down_bps: 1.2e6,
      up_bps: 0.4e6,
      down_24h: 22e9,
      up_24h: 3.1e9,
      down_trend: demoTrend(1.4e6, 0.9e6, 1),
      up_trend: demoTrend(0.4e6, 0.3e6, 9),
    }),
    demoDevice(4, "g4", { labelled: false, down_bps: 0.05e6, up_bps: 0.02e6, down_24h: 0.4e9, up_24h: 0.1e9, down_trend: demoTrend(0.05e6, 0.03e6, 4), up_trend: demoTrend(0.02e6, 0.01e6, 6) }),
  ],
};

export function fetchBandwidth() {
  if (DEMO) return Promise.resolve({ ...DEMO_SNAPSHOT, updated_at: Date.now() / 1000 });
  return fetch("/api/bandwidth").then(jsonOrThrow);
}

// A rate in bits/s with its own unit: "11.4 Mbps", "84 kbps", "0". Devices span
// four orders of magnitude, so one fixed unit would print a Pi-hole as "0".
export function formatRate(bps) {
  if (bps == null) return "—";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${bps >= 1e7 ? Math.round(bps / 1e6) : (bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return bps >= 1 ? `${Math.round(bps)} bps` : "0";
}

// Bytes moved: "58 GB". Missing means Prometheus hasn't answered yet, not zero.
export function formatMoved(bytes) {
  return bytes == null ? "—" : formatBytes(bytes);
}

// The order of the table: the uplink first (everything runs through it), then
// the devices by what they moved today, so the top of the list is who used the
// most. The order follows a day's total, not this second's rate, so rows don't
// jump around between polls. A device with no total yet sorts by port.
export function orderDevices(devices) {
  const moved = (d) => (d.down_24h ?? 0) + (d.up_24h ?? 0);
  return [...devices].sort((a, b) => {
    if (a.uplink !== b.uplink) return a.uplink ? -1 : 1;
    return moved(b) - moved(a) || a.index - b.index;
  });
}

// Share of what all the devices moved in 24 hours (the uplink excluded: it is
// the sum of the others plus the internet, so counting it would double everything).
export function shareOfDay(device, devices) {
  const total = devices.filter((d) => !d.uplink).reduce((sum, d) => sum + (d.down_24h ?? 0) + (d.up_24h ?? 0), 0);
  const mine = (device.down_24h ?? 0) + (device.up_24h ?? 0);
  return total > 0 && !device.uplink ? mine / total : null;
}
