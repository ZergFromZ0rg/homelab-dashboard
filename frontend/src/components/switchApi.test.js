import { describe, expect, it } from "vitest";
import { formatLinkSpeed, formatMbps, speedHint, speedTone } from "./switchApi";

describe("formatMbps", () => {
  it("keeps one decimal while it matters and rounds once it doesn't", () => {
    expect(formatMbps(400_000)).toBe("0.4");
    expect(formatMbps(11_400_000)).toBe("11");
    expect(formatMbps(940_000_000)).toBe("940");
  });

  it("shows an idle port as 0, not 0.0", () => {
    expect(formatMbps(0)).toBe("0");
    expect(formatMbps(20_000)).toBe("0");
  });

  it("has no number for a missing value", () => {
    expect(formatMbps(null)).toBe("—");
  });
});

describe("formatLinkSpeed", () => {
  it("writes gigabit and fast-ethernet the way switches label them", () => {
    expect(formatLinkSpeed(1000)).toBe("1G");
    expect(formatLinkSpeed(2500)).toBe("2.5G");
    expect(formatLinkSpeed(100)).toBe("100M");
    expect(formatLinkSpeed(null)).toBe("—");
    expect(formatLinkSpeed(0)).toBe("—");
  });
});

describe("speedTone", () => {
  const port = (speed, usual, up = true) => ({ up, speed_mbps: speed, usual_speed_mbps: usual });

  it("is bad below what the port usually does, and says so", () => {
    expect(speedTone(port(100, 1000))).toBe("bad");
    expect(speedHint(port(100, 1000))).toContain("usually 1000");
  });

  it("only warns about a port that has always been below gigabit", () => {
    expect(speedTone(port(100, 100))).toBe("warn");
  });

  it("leaves a healthy gigabit port alone", () => {
    expect(speedTone(port(1000, 1000))).toBe("");
  });

  it("has no opinion about a port with no link", () => {
    expect(speedTone(port(null, 1000, false))).toBe("");
    expect(speedHint(port(null, 1000, false))).toBe("No link");
  });
});
