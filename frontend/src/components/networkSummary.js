import { orderDevices, shareOfDay } from "./bandwidthApi";
import { checkTotals } from "./checkStatus";
import { formatLatency } from "./format";
import { piholeState } from "./piholeApi";
import { latestQuiet } from "./speedtestApi";
import { speedTone } from "./switchApi";

// What the Network overview works out from its sources. Everything here is a
// plain function of the data, so each panel can say "I have nothing" without
// the page falling over, and it can be tested without a browser.

// --- the network's problems ----------------------------------------------------------

// The keys of the overview's issues that belong to the network: a check, Pi-hole,
// the switch, the router's link, a device, the LAN watch.
const NETWORK_KEY = /^(check|network|netwatch):/;
export const isNetworkIssue = (issue) => NETWORK_KEY.test(issue.key);

const SEVERITY = { bad: 0, warn: 1 };

// The network's problems, worst first and otherwise in the order they came.
export function networkIssues(issues = []) {
  return issues
    .filter(isNetworkIssue)
    .map((issue, i) => [issue, i])
    .sort(([a, i], [b, j]) => (SEVERITY[a.severity] ?? 2) - (SEVERITY[b.severity] ?? 2) || i - j)
    .map(([issue]) => issue);
}

// "bad" when any of them is, else "warn" when there are some, else null.
export function issuesTone(issues) {
  if (issues.some((i) => i.severity === "bad")) return "bad";
  return issues.length ? "warn" : null;
}

// Where a network problem lives, as a page of the Network tab — and for a check,
// which one. The switch's ports are a panel of the Overview, so a port's problem
// opens it.
export function issueSection(key) {
  if (key.startsWith("check:")) return { section: "checks", check: key.split(":")[1] };
  if (key.startsWith("netwatch:")) return { section: "watch" };
  if (/^network:(pihole-|new-devices|offline:|block-spike)/.test(key)) return { section: "dns" };
  if (/^network:(internet-|wan-)/.test(key)) return { section: "bandwidth" };
  return { section: "overview" };
}

// --- the strip of headline numbers ---------------------------------------------------

// A speed in Mbps with just enough digits: 94, 10, 9.4.
export const speedFigure = (mbps) => (mbps == null ? "—" : mbps >= 10 ? String(Math.round(mbps)) : mbps.toFixed(1));

// Each item is shown only when its source has something to say: no Pi-hole
// connected means no DNS number, not a "0%".
export function summaryItems({ ready = true, issues = [], checks = [], speed = null, pihole = null, sw = null }) {
  const items = [];
  const tone = issuesTone(issues);
  items.push({
    id: "network",
    label: "Network",
    value: !ready ? "—" : issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "all clear",
    tone: !ready ? null : (tone ?? "ok"),
  });

  if (checks.length) {
    const t = checkTotals(checks);
    items.push({
      id: "services",
      label: "Services",
      value: `${t.answering}/${t.total}`,
      tone: t.down ? "bad" : t.slow ? "warn" : null,
      title: [`${t.answering} of ${t.total} checks are answering`, t.slow && `${t.slow} slow`, t.behind && `${t.behind} behind a down check`, t.paused && `${t.paused} paused`]
        .filter(Boolean)
        .join(" · "),
    });
  }

  const results = speed?.results || [];
  const last = latestQuiet(results) || results[results.length - 1];
  if (last) {
    items.push({
      id: "internet",
      label: "Internet",
      value: `${speedFigure(last.down_mbps)}↓ ${speedFigure(last.up_mbps)}↑`,
      title: "Mbps, from the last speed test",
    });
    items.push({ id: "ping", label: "Ping", value: formatLatency(last.ping_ms), title: "Round trip to Cloudflare in the last speed test" });
  }

  const dns = pihole ? piholeState(pihole) : "unconfigured";
  if (dns !== "unconfigured") {
    const reachable = dns === "up" || dns === "stale";
    if (reachable && pihole.summary) {
      items.push({ id: "dns", label: "DNS", value: `${pihole.summary.percent_blocked}% blocked`, tone: dns === "stale" ? "warn" : null, title: "Share of today's queries Pi-hole blocked" });
    } else if (!reachable) {
      items.push({ id: "dns", label: "DNS", value: "unreachable", tone: "bad", title: pihole.error || "The dashboard can't reach Pi-hole" });
    }
    if (pihole.summary) items.push({ id: "devices", label: "Devices", value: `${pihole.summary.active_clients} active`, title: "Devices that asked Pi-hole for DNS today" });
  }

  if (sw && sw.state !== "unconfigured" && sw.state !== "loading") {
    const ports = portsSummary(sw.ports);
    if (sw.state === "up" && ports.total) {
      items.push({ id: "switch", label: "Switch", value: `${ports.up}/${ports.total} up`, tone: ports.down ? "warn" : null, title: "Ports with a link" });
    } else if (sw.state !== "up") {
      items.push({ id: "switch", label: "Switch", value: sw.state === "down" ? "not answering" : "unknown", tone: sw.state === "down" ? "bad" : "warn" });
    }
  }
  return items;
}

// --- the switch -----------------------------------------------------------------------

export function portsSummary(ports = []) {
  const up = ports.filter((p) => p.up).length;
  return {
    total: ports.length,
    up,
    down: ports.length - up,
    slow: ports.filter((p) => speedTone(p)).length,
    errors: ports.filter((p) => (p.errors_24h ?? 0) > 0).length,
  };
}

// --- who is using the network ---------------------------------------------------------

const moved = (d) => (d.down_24h ?? 0) + (d.up_24h ?? 0);

// The devices that moved the most, biggest first, each with its share of what the
// devices moved. The internet's own row is the line, not a device, and the
// "Not on the switch" row (Wi-Fi and anything else on the router) is returned apart.
export function topUsers(snapshot, limit = 5) {
  const ordered = orderDevices(snapshot?.devices || []);
  const devices = ordered.filter((d) => !d.uplink && !d.derived);
  const other = ordered.find((d) => d.derived && d.down_24h != null) ?? null;
  return {
    rows: devices.slice(0, limit).map((device) => ({ device, share: shareOfDay(device, ordered), moved: moved(device) })),
    more: Math.max(0, devices.length - limit),
    other: other ? { moved: other.down_24h } : null,
    window: snapshot?.totals_window || "24h",
  };
}

// Whether the router's own counters gave a two-hour trend of the internet link to
// draw (they need the router to answer UPnP).
export function hasTraffic(snapshot) {
  const uplink = (snapshot?.devices || []).find((d) => d.uplink && d.up);
  return (uplink?.down_trend?.length ?? 0) > 1;
}

// --- between hosts --------------------------------------------------------------------

// One pair's state: a ping that is lost or slow is amber, a dead one red.
export function pairState(cell) {
  const lossy = (cell.loss_pct_3h ?? 0) >= 1;
  if (cell.status === "down") return "down";
  if (cell.status === "degraded" || lossy) return "slow";
  return cell.latency_ms == null ? "none" : "up";
}

const PAIR_RANK = { down: 0, slow: 1, none: 2, up: 3 };

// The pairs of the matrix as rows, the trouble first.
export function pairRows(matrix) {
  return (matrix?.cells ?? [])
    .map((cell) => ({ cell, state: pairState(cell) }))
    .sort((a, b) => PAIR_RANK[a.state] - PAIR_RANK[b.state] || a.cell.from.localeCompare(b.cell.from) || a.cell.to.localeCompare(b.cell.to));
}

// --- devices -------------------------------------------------------------------------

// Devices nobody has named or identified yet, new ones first. Ones not seen for a
// week are not news.
export function needsAName(devices = [], limit = 3) {
  const open = devices
    .filter((d) => !d.ghost && (d.new || d.kind === "unknown"))
    .sort((a, b) => Number(Boolean(b.new)) - Number(Boolean(a.new)) || a.name.localeCompare(b.name));
  return { total: open.length, rows: open.slice(0, limit) };
}
