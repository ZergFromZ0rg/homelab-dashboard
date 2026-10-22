import { describe, expect, it } from "vitest";
import { arrange, checkTotals, describeCheck, isBehind, isRootDown, shortStatus, uptimeTone, worstCheck } from "./checkStatus";

const c = (id, name, status, extra = {}) => ({ id, name, status, group: null, parent: null, suppressed_by: null, ...extra });

describe("checkStatus", () => {
  it("counts only root causes as down", () => {
    const router = c("r", "router", "down");
    const kid = c("k", "jelly", "down", { suppressed_by: { id: "r", name: "router" } });
    expect([router, kid].filter(isRootDown)).toEqual([router]);
    expect([router, kid].filter(isBehind)).toEqual([kid]);
  });

  it("groups, nests dependents under their parent, worst first, ungrouped last", () => {
    const list = [
      c("a", "alpha", "up", { group: "Z" }),
      c("loose", "loose", "down"),
      c("r", "router", "up", { group: "Net" }),
      c("s", "switch", "down", { group: "Net", parent: "r" }),
      c("p", "pihole", "degraded", { group: "Net" }),
    ];
    const groups = arrange(list);
    expect(groups.map((g) => g.name)).toEqual(["Net", "Z", ""]);
    // pihole (degraded) sorts before router (up); the switch hangs under the router
    expect(groups[0].rows.map((r) => [r.check.name, r.depth])).toEqual([
      ["pihole", 0], ["router", 0], ["switch", 1],
    ]);
    expect(groups[0]).toMatchObject({ down: 1, slow: 1 });
  });

  it("keeps a child whose parent lives in another group at the top of its own group", () => {
    const groups = arrange([c("r", "router", "up", { group: "A" }), c("k", "kid", "up", { group: "B", parent: "r" })]);
    expect(groups.find((g) => g.name === "B").rows[0].depth).toBe(0);
  });
});

describe("uptimeTone", () => {
  it("is green from 99.5, amber from 95, red below, and nothing when unknown", () => {
    expect([100, 99.5, 99.49, 95, 94.9, null].map(uptimeTone)).toEqual(["ok", "ok", "warn", "warn", "bad", "none"]);
  });
});

describe("worstCheck", () => {
  it("picks a down root cause before what is behind it, then the slow ones, then the rest", () => {
    const root = c("r", "router", "down");
    const kid = c("k", "jelly", "down", { suppressed_by: { id: "r", name: "router" } });
    const slow = c("s", "grafana", "degraded");
    const fine = c("a", "alpha", "up");
    expect(worstCheck([fine, slow, kid, root]).id).toBe("r");
    expect(worstCheck([fine, slow, kid]).id).toBe("k");
    expect(worstCheck([fine, slow]).id).toBe("s");
    expect(worstCheck([])).toBeNull();
  });
});

describe("describeCheck", () => {
  const now = 10_000;

  it("says how long a check has been down and why, or what it is behind", () => {
    expect(describeCheck(c("a", "a", "down", { down_since: now - 1080, detail: "HTTP 502" }), now)).toEqual({
      headline: "Down",
      sub: "18m · HTTP 502",
    });
    expect(describeCheck(c("a", "a", "down", { suppressed_by: { id: "r", name: "Nextcloud" } }), now).sub).toBe("behind Nextcloud");
  });

  it("gives a slow check its latency and what it is over", () => {
    const slow = c("a", "a", "degraded", { latency_ms: 88.9, slow_ms: 80, lossy: false });
    expect(describeCheck(slow, now)).toEqual({ headline: "89 ms", sub: "slow · over 80 ms" });
  });

  it("gives a healthy ping its loss and jitter", () => {
    const up = c("a", "a", "up", { latency_ms: 0.9, loss_pct_3h: 0, jitter_ms_3h: 0.2 });
    expect(describeCheck(up, now)).toEqual({ headline: "0.9 ms", sub: "loss 0% · jitter 0.2 ms" });
  });

  it("reads a certificate's days left, and a probe that can't run", () => {
    expect(describeCheck(c("a", "a", "up", { type: "tls", detail: "23 days left" }), now).headline).toBe("23 d left");
    expect(describeCheck(c("a", "a", "pending", { probe_error: "agent unreachable" }), now)).toEqual({
      headline: "Can't probe",
      sub: "agent unreachable",
    });
    expect(describeCheck(c("a", "a", "paused"), now).headline).toBe("Paused");
  });
});

describe("shortStatus", () => {
  const now = 10_000;

  it("is one short word or figure per row", () => {
    expect(shortStatus(c("a", "a", "down", { down_since: now - 1080 }), now)).toBe("down 18m");
    expect(shortStatus(c("a", "a", "down"), now)).toBe("down");
    expect(shortStatus(c("a", "a", "down", { suppressed_by: { id: "r", name: "r" } }), now)).toBe("behind");
    expect(shortStatus(c("a", "a", "up", { latency_ms: 34.2 }), now)).toBe("34 ms");
    expect(shortStatus(c("a", "a", "degraded", { latency_ms: 88.9 }), now)).toBe("89 ms");
    expect(shortStatus(c("a", "a", "paused"), now)).toBe("paused");
    expect(shortStatus(c("a", "a", "up", { type: "tls", detail: "9 days left" }), now)).toBe("9 d");
  });
});

describe("checkTotals", () => {
  it("counts what answers, what is slow, down (roots only), behind and paused", () => {
    const list = [
      c("a", "a", "up", { p50_ms_24h: 10, p95_ms_24h: 20, uptime_24h: 100 }),
      c("b", "b", "degraded", { p50_ms_24h: 30, p95_ms_24h: 90, uptime_24h: 98 }),
      c("r", "r", "down", { p50_ms_24h: 20, p95_ms_24h: 40, uptime_24h: 90, incidents_24h: 2 }),
      c("k", "k", "down", { suppressed_by: { id: "r", name: "r" }, incidents_24h: 1 }),
      c("p", "p", "paused"),
    ];
    expect(checkTotals(list)).toMatchObject({ total: 5, answering: 2, down: 1, behind: 1, slow: 1, paused: 1, typical: 20, incidents: 3 });
    expect(checkTotals(list).worst.id).toBe("b");
    expect(checkTotals(list).uptime).toBeCloseTo(96, 5);
  });

  it("has no figures, rather than zeros, when nothing has been measured", () => {
    expect(checkTotals([])).toMatchObject({ total: 0, typical: null, worst: null, uptime: null });
  });
});
