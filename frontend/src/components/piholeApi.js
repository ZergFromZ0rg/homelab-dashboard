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
