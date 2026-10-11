import { DEMO } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// GET /api/pihole/history?range= — DNS over hours to months, from Pi-hole's own
// long-term database. A point is queries per hour whatever the range, so a day
// and a month read on one scale.

export const DNS_RANGES = ["24h", "7d", "30d", "90d"];
const SPANS = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };
const STEPS = { "24h": 600, "7d": 3600, "30d": 21600, "90d": 86400 };

function demoHistory(range) {
  const span = SPANS[range];
  const step = STEPS[range];
  const end = Math.floor(Date.now() / 1000);
  const count = Math.round(span / step);
  const points = Array.from({ length: count }, (_, i) => {
    const t = end - span + i * step;
    const hour = (t / 3600) % 24;
    const day = Math.max(0.15, Math.sin(((hour - 6) / 24) * Math.PI * 2) * 0.5 + 0.55);
    const perHour = 1900 * day + Math.sin(i / 3) * 90;
    return {
      t,
      queries_per_hour: Math.round(perHour),
      blocked_pct: Math.round((6 + Math.sin(i / 5) * 2 + (i % 23 === 0 ? 7 : 0)) * 10) / 10,
      queries: Math.round((perHour * step) / 3600),
      blocked: 0,
    };
  });
  const queries = points.reduce((a, p) => a + p.queries, 0);
  return {
    range,
    step,
    start: end - span,
    end,
    // A freshly set-up Pi-hole only has a couple of days to show.
    covers_seconds: Math.min(span, 4 * 86400),
    points: range === "24h" ? points : points.slice(-Math.round((4 * 86400) / step)),
    summary: { queries, blocked: Math.round(queries * 0.061), blocked_pct: 6.1, clients: 32 },
    top_asked: [
      ["bigboy", 5120], ["github.com", 3290], ["gateway.fe2.apple-dns.net", 2870], ["api.snapchat.com", 1410], ["time.cloudflare.com", 960],
    ].map(([domain, count]) => ({ domain, count })),
    top_blocked: [
      ["mask.icloud.com", 1587], ["mask-h2.icloud.com", 292], ["_dns.resolver.arpa", 197], ["googleads.g.doubleclick.net", 69],
    ].map(([domain, count]) => ({ domain, count })),
    top_clients: [
      ["192.168.0.247", "thinkpad", 17054], ["127.0.0.1", "localhost", 9867], ["192.168.0.207", "dad's phone", 4498], ["192.168.0.211", "living room TV", 3120],
    ].map(([ip, name, count]) => ({ ip, name, count })),
  };
}

export function fetchPiholeHistory(range) {
  if (DEMO) return Promise.resolve(demoHistory(range));
  return fetch(`/api/pihole/history?range=${encodeURIComponent(range)}`).then(jsonOrThrow);
}

// "3 days of history so far" when Pi-hole's database is younger than the range.
export function coverageNote(data) {
  if (!data) return null;
  const span = data.end - data.start;
  if (data.covers_seconds >= span * 0.9) return null;
  const days = data.covers_seconds / 86400;
  return days >= 1 ? `Pi-hole has ${Math.round(days * 10) / 10} days of history so far` : `Pi-hole has ${Math.max(1, Math.round(data.covers_seconds / 3600))} hours of history so far`;
}
