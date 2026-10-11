import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// GET /api/host-history/{host}?range= — a host over hours to months: CPU, memory,
// load, CPU temperature (peak), network and disk fill from Prometheus, and the
// GPU from the dashboard's own store. Fetched only while the view is open.

export const RANGES = ["6h", "24h", "7d", "30d", "90d"];
const SPANS = { "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };
const STEPS = { "6h": 60, "24h": 300, "7d": 1800, "30d": 7200, "90d": 21600 };

function demoSeries(range, base, swing, seed, floor = 0) {
  const span = SPANS[range];
  const step = STEPS[range];
  const end = Math.floor(Date.now() / 1000);
  const count = Math.round(span / step);
  return Array.from({ length: count }, (_, i) => {
    const t = end - span + i * step;
    const day = Math.sin(((t / 86400) + seed / 10) * Math.PI * 2);
    const week = Math.sin((t / (7 * 86400) + seed) * Math.PI * 2);
    const noise = Math.sin(i / 3 + seed) * 0.3 + Math.cos(i / 7) * 0.2;
    return { t, v: Math.max(floor, base + swing * (day * 0.6 + week * 0.3 + noise)) };
  });
}

function demoHistory(host, range) {
  const seed = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 97, 3);
  const series = {
    cpu: demoSeries(range, 18, 14, seed),
    ram: demoSeries(range, 46, 8, seed + 1),
    load: demoSeries(range, 1.2, 0.9, seed + 2),
    temperature: demoSeries(range, 54, 12, seed + 3),
    network_rx: demoSeries(range, 1.4e6, 1.2e6, seed + 4),
    network_tx: demoSeries(range, 0.4e6, 0.35e6, seed + 5),
    disks: [
      { mountpoint: "/", device: "/dev/nvme0n1p2", points: demoSeries(range, 46, 2, seed + 6) },
      { mountpoint: "/mnt/media", device: "/dev/sda1", points: demoSeries(range, 80, 6, seed + 7) },
    ],
  };
  const gpuPoints = demoSeries(range, 30, 25, seed + 8).map((p, i) => ({
    t: p.t,
    utilization: Math.min(100, p.v),
    memory: 35 + (i % 20),
    temperature: 45 + (p.v / 4),
    power: 20 + p.v,
  }));
  return {
    host,
    range,
    step: STEPS[range],
    prometheus: true,
    series,
    gpus: host === "bigboy" ? [{ key: "0000:01:00.0", name: "NVIDIA GeForce GTX 1650 SUPER", points: gpuPoints }] : [],
  };
}

export function fetchHostHistory(host, range) {
  if (DEMO) return Promise.resolve(demoHistory(host, range));
  return fetch(`/api/host-history/${encodeURIComponent(host)}?range=${encodeURIComponent(range)}`).then(jsonOrThrow);
}

// "each point is 30 min" for the note beside the range picker.
export function stepLabel(seconds) {
  if (!seconds) return "";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
