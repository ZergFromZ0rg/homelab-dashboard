import { describe, expect, it } from "vitest";
import { formatMoved, formatRate, orderDevices, shareOfDay } from "./bandwidthApi";
import { history, latestQuiet, scheduleLabel } from "./speedtestApi";

const device = (index, name, over = {}) => ({ index, name, uplink: false, down_24h: 0, up_24h: 0, ...over });

describe("formatRate", () => {
  it("picks the unit a device actually lives in", () => {
    expect(formatRate(940e6)).toBe("940 Mbps");
    expect(formatRate(11.4e6)).toBe("11 Mbps");
    expect(formatRate(2.14e6)).toBe("2.1 Mbps");
    expect(formatRate(84_400)).toBe("84 kbps");
    expect(formatRate(2.5e9)).toBe("2.5 Gbps");
  });

  it("calls nothing zero and missing a dash", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(null)).toBe("—");
  });
});

describe("formatMoved", () => {
  it("keeps 'no answer yet' apart from zero", () => {
    expect(formatMoved(null)).toBe("—");
    expect(formatMoved(0)).toBe("0 B");
  });
});

describe("orderDevices", () => {
  it("puts the uplink first, then whoever moved the most today", () => {
    const rows = [
      device(2, "quiet", { down_24h: 1e6 }),
      device(1, "router", { uplink: true, down_24h: 5e9 }),
      device(3, "busy", { down_24h: 2e9, up_24h: 1e9 }),
    ];
    expect(orderDevices(rows).map((d) => d.name)).toEqual(["router", "busy", "quiet"]);
  });

  it("falls back to port order when nothing has a total yet", () => {
    const rows = [device(3, "c", { down_24h: null }), device(2, "b", { down_24h: null })];
    expect(orderDevices(rows).map((d) => d.name)).toEqual(["b", "c"]);
  });

  it("does not reorder the list it is given", () => {
    const rows = [device(2, "b", { down_24h: 1 }), device(1, "a", { down_24h: 9 })];
    orderDevices(rows);
    expect(rows.map((d) => d.name)).toEqual(["b", "a"]);
  });
});

describe("shareOfDay", () => {
  const rows = [
    device(1, "router", { uplink: true, down_24h: 9e9 }),
    device(2, "a", { down_24h: 3e9 }),
    device(3, "b", { up_24h: 1e9 }),
  ];

  it("is a device's part of what the devices moved, not counting the uplink", () => {
    expect(shareOfDay(rows[1], rows)).toBe(0.75);
    expect(shareOfDay(rows[2], rows)).toBe(0.25);
  });

  it("is nothing for the uplink, which is the sum of the rest and more", () => {
    expect(shareOfDay(rows[0], rows)).toBeNull();
  });

  it("is nothing before any totals exist", () => {
    const empty = [device(1, "a", { down_24h: null })];
    expect(shareOfDay(empty[0], empty)).toBeNull();
  });
});

describe("speed test helpers", () => {
  const now = Date.now() / 1000;
  const results = [
    { at: now - 9 * 86400, down_mbps: 80, busy: false },
    { at: now - 3600, down_mbps: 90, busy: false },
    { at: now - 60, down_mbps: 12, busy: true },
  ];

  it("reads the latest result taken on a quiet line", () => {
    expect(latestQuiet(results).down_mbps).toBe(90);
    expect(latestQuiet([])).toBeNull();
    expect(latestQuiet([{ at: 1, busy: true }])).toBeNull();
  });

  it("charts only the last week", () => {
    expect(history(results, "down_mbps").map((p) => p.v)).toEqual([90, 12]);
  });

  it("names the schedule", () => {
    expect([0, 1, 6, 24].map(scheduleLabel)).toEqual(["Off", "Every 1h", "Every 6h", "Daily"]);
  });
});
