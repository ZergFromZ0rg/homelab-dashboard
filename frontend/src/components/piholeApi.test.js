import { describe, expect, it } from "vitest";
import { piholeState } from "./piholeApi";

describe("piholeState", () => {
  it("says unconfigured until the collector has credentials", () => {
    expect(piholeState(null)).toBe("unconfigured");
    expect(piholeState({ configured: false })).toBe("unconfigured");
  });

  it("tells never-reached from lost-contact", () => {
    expect(piholeState({ configured: true, reachable: false, updated_at: null })).toBe("down");
    expect(piholeState({ configured: true, reachable: false, updated_at: 5 })).toBe("unreachable");
  });

  it("flags stale data and passes healthy", () => {
    expect(piholeState({ configured: true, reachable: true, stale: true, updated_at: 5 })).toBe("stale");
    expect(piholeState({ configured: true, reachable: true, stale: false, updated_at: 5 })).toBe("up");
  });
});

import { formatCountdown, pauseRemaining } from "./piholeApi";

describe("pauseRemaining", () => {
  const paused = (timer, updated_at) => ({ blocking: { enabled: false, timer }, updated_at });

  it("counts down from when Pi-hole was last asked", () => {
    expect(pauseRemaining(paused(300, 1000), 1060)).toBe(240);
    expect(pauseRemaining(paused(30, 1000), 1090)).toBe(0);
  });

  it("is null when there is nothing to count", () => {
    expect(pauseRemaining({ blocking: { enabled: true, timer: null } }, 5)).toBeNull();
    expect(pauseRemaining(paused(null, 1000), 1060)).toBeNull();
    expect(pauseRemaining(null)).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("reads as a clock, and hours for long pauses", () => {
    expect(formatCountdown(272)).toBe("4:32");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(3900)).toBe("1h 05m");
    expect(formatCountdown(null)).toBe("");
  });
});
