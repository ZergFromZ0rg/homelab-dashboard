import { formatDuration, formatLatency } from "./format";

export const TYPE_LABEL = { http: "HTTP", keyword: "Keyword", ping: "Ping", tcp: "TCP", dns: "DNS", tls: "Cert" };

// The dot a status wears.
export const STATUS_TONE = { up: "ok", degraded: "warn", down: "bad", paused: "none", pending: "none" };

// How a 24 h / 7 d / 30 d uptime figure reads: green from 99.5, amber from 95.
export function uptimeTone(value) {
  if (value == null) return "none";
  if (value >= 99.5) return "ok";
  if (value >= 95) return "warn";
  return "bad";
}

// A check "behind" a down dependency is failing too, but the dependency is
// the news: counts and badges use the root causes only.
export const isRootDown = (c) => c.status === "down" && !c.suppressed_by;
export const isBehind = (c) => c.status === "down" && Boolean(c.suppressed_by);
export const isAnswering = (c) => c.status === "up" || c.status === "degraded";

// Rows grouped by `group` (ungrouped last), each group's roots first and a
// check's dependents right under it. Worst status leads at every level.
const RANK = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
const byWorst = (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name);

export function arrange(checks) {
  const byGroup = new Map();
  for (const c of checks) {
    const key = c.group ?? "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }

  const groups = [...byGroup.entries()].map(([name, members]) => {
    const ids = new Set(members.map((m) => m.id));
    const kids = new Map();
    for (const m of members) {
      if (m.parent && ids.has(m.parent)) {
        if (!kids.has(m.parent)) kids.set(m.parent, []);
        kids.get(m.parent).push(m);
      }
    }
    const rows = [];
    const walk = (c, depth) => {
      rows.push({ check: c, depth });
      for (const k of (kids.get(c.id) ?? []).sort(byWorst)) walk(k, depth + 1);
    };
    members
      .filter((m) => !(m.parent && ids.has(m.parent)))
      .sort(byWorst)
      .forEach((m) => walk(m, 0));
    return {
      name,
      rows,
      down: members.filter(isRootDown).length,
      slow: members.filter((m) => m.status === "degraded").length,
      worst: Math.min(...members.map((m) => RANK[m.status])),
    };
  });

  // Named groups, worst first; the ungrouped remainder always last.
  return groups.sort(
    (a, b) => (a.name === "") - (b.name === "") || a.worst - b.worst || a.name.localeCompare(b.name)
  );
}

// The check to look at first: the worst one, a root cause before what is behind it.
export function worstCheck(checks) {
  return [...checks].sort((a, b) => RANK[a.status] - RANK[b.status] || Number(Boolean(a.suppressed_by)) - Number(Boolean(b.suppressed_by)) || a.name.localeCompare(b.name))[0] ?? null;
}

// "loss 0% · jitter 0.3 ms" for a ping that sends several echoes.
export function linkQuality(check) {
  if (check.loss_pct_3h == null) return "";
  const jitter = check.jitter_ms_3h == null ? "" : ` · jitter ${formatLatency(check.jitter_ms_3h)}`;
  return `loss ${check.loss_pct_3h}%${jitter}`;
}

const DAYS_LEFT = /^(\d+) days? left/;

// What a check says right now, as a headline and a line under it. `now` is in
// epoch seconds.
export function describeCheck(check, now) {
  const { status } = check;
  let headline;
  let sub;
  if (status === "down") {
    headline = "Down";
    sub = check.suppressed_by
      ? `behind ${check.suppressed_by.name}`
      : `${check.down_since ? `${formatDuration(now - check.down_since)} · ` : ""}${check.detail ?? ""}`;
  } else if (status === "degraded") {
    headline = formatLatency(check.latency_ms);
    sub = [
      check.slow || !check.lossy ? `slow · over ${formatLatency(check.slow_ms)}` : null,
      check.lossy ? `losing packets · over ${check.max_loss}%` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (status === "paused") {
    headline = "Paused";
    sub = "";
  } else if (status === "pending") {
    headline = check.probe_error ? "Can't probe" : "Checking…";
    sub = check.probe_error ?? "";
  } else if (check.type === "tls" && DAYS_LEFT.test(check.detail ?? "")) {
    headline = `${check.detail.match(DAYS_LEFT)[1]} d left`;
    sub = "";
  } else {
    headline = formatLatency(check.latency_ms);
    sub = linkQuality(check);
  }

  if (check.probe_error && status !== "pending") sub = check.probe_error;
  return { headline, sub };
}

// One short word or figure for a dense row: "down 18m", "behind", "89 ms".
export function shortStatus(check, now) {
  switch (check.status) {
    case "down":
      if (check.suppressed_by) return "behind";
      return check.down_since ? `down ${formatDuration(now - check.down_since)}` : "down";
    case "paused":
      return "paused";
    case "pending":
      return "checking";
    default:
      if (check.type === "tls" && DAYS_LEFT.test(check.detail ?? "")) return `${check.detail.match(DAYS_LEFT)[1]} d`;
      return formatLatency(check.latency_ms);
  }
}

// What the checks add up to: how many are answering, a typical latency (the
// median of the checks' own medians), the worst 95th percentile — the one number
// that shows a spike an average hides — the mean 24 h uptime and the downtime
// episodes of the day.
export function checkTotals(checks) {
  const medians = checks.map((c) => c.p50_ms_24h).filter((v) => v != null).sort((a, b) => a - b);
  const worst = checks.filter((c) => c.p95_ms_24h != null).sort((a, b) => b.p95_ms_24h - a.p95_ms_24h)[0] ?? null;
  const uptimes = checks.map((c) => c.uptime_24h).filter((v) => v != null);
  return {
    total: checks.length,
    answering: checks.filter(isAnswering).length,
    down: checks.filter(isRootDown).length,
    behind: checks.filter(isBehind).length,
    slow: checks.filter((c) => c.status === "degraded").length,
    paused: checks.filter((c) => c.status === "paused").length,
    typical: medians.length ? medians[Math.floor(medians.length / 2)] : null,
    worst,
    uptime: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null,
    incidents: checks.reduce((n, c) => n + (c.incidents_24h ?? 0), 0),
  };
}
