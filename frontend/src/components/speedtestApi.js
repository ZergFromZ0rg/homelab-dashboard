import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// /api/speedtest — the internet speed history. A test is run by the dashboard's
// host against Cloudflare; Run starts one in the background and the page polls
// until `running` clears.

const HOUR = 3600;

function demoResults() {
  const now = Date.now() / 1000;
  const downs = [91, 94, 93, 88, 95, 92, 94, 61, 93, 94, 90, 92, 95, 93, 91, 94, 93, 92, 89, 94, 93, 95, 92, 94];
  return downs.map((d, i) => ({
    at: now - (downs.length - i) * 6 * HOUR + 600,
    down_mbps: d,
    up_mbps: 10.2 + ((i * 7) % 5) / 5,
    ping_ms: 12 + (i % 4),
    jitter_ms: 1.5 + (i % 3) / 2,
    busy: i === 7,
    manual: false,
  }));
}

let demo = { every_hours: 6, running: false, results: demoResults() };

function demoSnapshot() {
  const last = demo.results[demo.results.length - 1];
  return {
    ...demo,
    choices: [0, 1, 3, 6, 12, 24],
    error: null,
    next_at: demo.every_hours ? last.at + demo.every_hours * HOUR : null,
    link_mbps: 100,
  };
}

export function fetchSpeedtest() {
  if (DEMO) return Promise.resolve(demoSnapshot());
  return fetch("/api/speedtest").then(jsonOrThrow);
}

export function runSpeedtest() {
  if (DEMO) {
    demo = { ...demo, running: true };
    setTimeout(() => {
      const now = Date.now() / 1000;
      demo = { ...demo, running: false, results: [...demo.results, { at: now, down_mbps: 93.4, up_mbps: 10.9, ping_ms: 13, jitter_ms: 1.8, busy: false, manual: true }] };
    }, 4000);
    return Promise.resolve(demoSnapshot());
  }
  return fetch("/api/speedtest/run", { method: "POST" }).then(jsonOrThrow);
}

export function setSpeedtestSchedule(everyHours) {
  if (DEMO) {
    demo = { ...demo, every_hours: everyHours };
    return Promise.resolve(demoSnapshot());
  }
  return fetch("/api/speedtest/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ every_hours: everyHours }),
  }).then(jsonOrThrow);
}

// "Every 6h" / "Off" for the schedule picker.
export function scheduleLabel(hours) {
  return hours === 0 ? "Off" : hours === 24 ? "Daily" : `Every ${hours}h`;
}

// The newest result taken on a quiet line: a test run while the line was in use
// says how busy it was, not how fast it is.
export function latestQuiet(results) {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (!results[i].busy) return results[i];
  }
  return null;
}

// {t, v} points for a Sparkline from the last `days` of results.
export function history(results, field, days = 7) {
  const cutoff = Date.now() / 1000 - days * 86400;
  return results.filter((r) => r.at >= cutoff).map((r) => ({ t: r.at, v: r[field] }));
}
