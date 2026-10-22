import { describe, expect, it } from "vitest";
import {
  hasTraffic,
  isNetworkIssue,
  issueSection,
  issuesTone,
  needsAName,
  networkIssues,
  pairRows,
  pairState,
  portsSummary,
  speedFigure,
  summaryItems,
  topUsers,
} from "./networkSummary";

const issue = (key, severity = "warn") => ({ key, severity, title: key, message: "" });

describe("the network's problems", () => {
  it("keeps checks, network and watch issues, and leaves hosts and containers to their own tabs", () => {
    const all = [issue("host:bigboy:ram"), issue("check:k5", "bad"), issue("container:a:b:unhealthy"), issue("network:new-devices"), issue("netwatch:bigboy:g1")];
    expect(all.filter(isNetworkIssue).map((i) => i.key)).toEqual(["check:k5", "network:new-devices", "netwatch:bigboy:g1"]);
  });

  it("lists the worst first and otherwise keeps the order they came in", () => {
    const list = networkIssues([issue("network:a"), issue("check:b", "bad"), issue("network:c"), issue("check:d", "bad"), issue("host:x", "bad")]);
    expect(list.map((i) => i.key)).toEqual(["check:b", "check:d", "network:a", "network:c"]);
  });

  it("is quiet with no issues, and takes the worst tone otherwise", () => {
    expect(networkIssues(undefined)).toEqual([]);
    expect(issuesTone([])).toBeNull();
    expect(issuesTone([issue("a")])).toBe("warn");
    expect(issuesTone([issue("a"), issue("b", "bad")])).toBe("bad");
  });
});

describe("issueSection", () => {
  it("opens a check on the Uptime page with that check selected, whatever its alert is about", () => {
    expect(issueSection("check:k5")).toEqual({ section: "checks", check: "k5" });
    expect(issueSection("check:k5:slow")).toEqual({ section: "checks", check: "k5" });
    expect(issueSection("check:k5:loss")).toEqual({ section: "checks", check: "k5" });
  });

  it("opens Pi-hole's and the devices' problems on DNS", () => {
    for (const key of ["network:pihole-down", "network:new-devices", "network:offline:aabbcc", "network:block-spike"]) {
      expect(issueSection(key), key).toEqual({ section: "dns" });
    }
  });

  it("opens the internet's problems on Bandwidth and the LAN watch's on Watch", () => {
    expect(issueSection("network:internet-slow")).toEqual({ section: "bandwidth" });
    expect(issueSection("network:wan-down")).toEqual({ section: "bandwidth" });
    expect(issueSection("netwatch:bigboy:g1")).toEqual({ section: "watch" });
  });

  it("opens the switch's ports on the Overview, where they are", () => {
    expect(issueSection("network:switch-port-down:g5")).toEqual({ section: "overview" });
    expect(issueSection("network:switch-down")).toEqual({ section: "overview" });
  });
});

describe("summaryItems", () => {
  const checks = [
    { id: "a", status: "up", suppressed_by: null },
    { id: "b", status: "degraded", suppressed_by: null },
    { id: "c", status: "down", suppressed_by: null },
  ];
  const speed = { results: [{ at: 1, down_mbps: 94, up_mbps: 10.4, ping_ms: 15, busy: false }] };
  const pihole = { configured: true, reachable: true, stale: false, summary: { percent_blocked: 8.4, active_clients: 17 } };
  const sw = { state: "up", ports: [{ up: true, speed_mbps: 1000 }, { up: false }] };
  const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

  it("says all clear in green when nothing is wrong, and counts the issues when something is", () => {
    expect(byId(summaryItems({ issues: [] })).network).toMatchObject({ value: "all clear", tone: "ok" });
    expect(byId(summaryItems({ issues: [issue("check:k", "bad")] })).network).toMatchObject({ value: "1 issue", tone: "bad" });
    expect(byId(summaryItems({ issues: [issue("a"), issue("b")] })).network).toMatchObject({ value: "2 issues", tone: "warn" });
  });

  it("does not claim all clear before the first update has arrived", () => {
    expect(byId(summaryItems({ ready: false })).network).toMatchObject({ value: "—", tone: null });
  });

  it("works out every number it has a source for", () => {
    const items = byId(summaryItems({ checks, speed, pihole, sw }));
    expect(items.services).toMatchObject({ value: "2/3", tone: "bad" });
    expect(items.internet.value).toBe("94↓ 10↑");
    expect(items.ping.value).toBe("15 ms");
    expect(items.dns.value).toBe("8.4% blocked");
    expect(items.devices.value).toBe("17 active");
    expect(items.switch).toMatchObject({ value: "1/2 up", tone: "warn" });
  });

  it("leaves out what has no source, instead of showing zeros", () => {
    const items = summaryItems({ checks: [], speed: null, pihole: { configured: false }, sw: { state: "unconfigured" } });
    expect(items.map((i) => i.id)).toEqual(["network"]);
  });

  it("marks Pi-hole and the switch when they don't answer", () => {
    const down = byId(summaryItems({ pihole: { configured: true, reachable: false, stale: false, error: "timed out" }, sw: { state: "down", ports: [] } }));
    expect(down.dns).toMatchObject({ value: "unreachable", tone: "bad" });
    expect(down.switch).toMatchObject({ value: "not answering", tone: "bad" });
  });
});

describe("portsSummary", () => {
  it("counts the ports with a link, the ones below gigabit and the ones with errors", () => {
    const ports = [
      { up: true, speed_mbps: 1000, usual_speed_mbps: 1000, errors_24h: 0 },
      { up: true, speed_mbps: 100, usual_speed_mbps: 100, errors_24h: 3 },
      { up: false, speed_mbps: null, errors_24h: 0 },
    ];
    expect(portsSummary(ports)).toEqual({ total: 3, up: 2, down: 1, slow: 1, errors: 1 });
    expect(portsSummary(undefined)).toEqual({ total: 0, up: 0, down: 0, slow: 0, errors: 0 });
  });
});

describe("topUsers", () => {
  const d = (index, name, down, up, over = {}) => ({ index, name, down_24h: down, up_24h: up, uplink: false, derived: false, ...over });
  const snapshot = {
    totals_window: "24h",
    devices: [
      d(0, "Internet", 60e9, 9e9, { uplink: true }),
      d(3, "thinkpad", 22e9, 3e9),
      d(2, "bigboy", 14e9, 205e9),
      d(4, "g4", 0.4e9, 0.1e9),
      d(10000, "Not on the switch", 41e9, null, { derived: true }),
    ],
  };

  it("lists the devices by what they moved, with their share, and leaves the internet's own row out", () => {
    const { rows } = topUsers(snapshot);
    expect(rows.map((r) => r.device.name)).toEqual(["bigboy", "thinkpad", "g4"]);
    expect(rows[0].share).toBeCloseTo(219 / 244.5, 3);
    expect(rows[0].moved).toBe(219e9);
  });

  it("returns what Wi-Fi and the rest moved apart, and how many more there were", () => {
    const { other, more, rows } = topUsers(snapshot, 2);
    expect(rows).toHaveLength(2);
    expect(more).toBe(1);
    expect(other).toEqual({ moved: 41e9 });
  });

  it("copes with a switch that isn't reporting", () => {
    expect(topUsers(null)).toMatchObject({ rows: [], more: 0, other: null, window: "24h" });
  });
});

describe("hasTraffic", () => {
  it("is true when the internet link has a trend to draw, and false without one", () => {
    const trend = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
    expect(hasTraffic({ devices: [{ uplink: true, up: true, down_trend: trend }] })).toBe(true);
    expect(hasTraffic({ devices: [{ uplink: true, up: true, down_trend: [] }] })).toBe(false);
    expect(hasTraffic({ devices: [{ uplink: false, up: true, down_trend: trend }] })).toBe(false);
    expect(hasTraffic(null)).toBe(false);
  });
});

describe("between hosts", () => {
  const cell = (from, to, over = {}) => ({ from, to, status: "up", latency_ms: 1, loss_pct_3h: 0, ...over });

  it("calls a lost or slow ping amber, a dead one red and an unmeasured one nothing", () => {
    expect(pairState(cell("a", "b"))).toBe("up");
    expect(pairState(cell("a", "b", { loss_pct_3h: 2 }))).toBe("slow");
    expect(pairState(cell("a", "b", { status: "degraded" }))).toBe("slow");
    expect(pairState(cell("a", "b", { status: "down", latency_ms: null }))).toBe("down");
    expect(pairState(cell("a", "b", { status: "pending", latency_ms: null }))).toBe("none");
  });

  it("lists the trouble first", () => {
    const rows = pairRows({ cells: [cell("a", "b"), cell("b", "a", { loss_pct_3h: 5 }), cell("a", "c", { status: "down", latency_ms: null })] });
    expect(rows.map((r) => `${r.cell.from}>${r.cell.to}`)).toEqual(["a>c", "b>a", "a>b"]);
    expect(pairRows(null)).toEqual([]);
  });
});

describe("needsAName", () => {
  it("lists new and unidentified devices, new first, and not the ones gone for a week", () => {
    const devices = [
      { name: "zed", kind: "unknown" },
      { name: "macbook", kind: "personal" },
      { name: "echo", kind: "unknown", new: true },
      { name: "gone", kind: "unknown", ghost: "stale" },
      { name: "alpha", kind: "unknown" },
    ];
    const { total, rows } = needsAName(devices, 2);
    expect(total).toBe(3);
    expect(rows.map((r) => r.name)).toEqual(["echo", "alpha"]);
  });
});

describe("speedFigure", () => {
  it("keeps one decimal only for small speeds", () => {
    expect([speedFigure(94.04), speedFigure(10.4), speedFigure(9.44), speedFigure(null)]).toEqual(["94", "10", "9.4", "—"]);
  });
});
