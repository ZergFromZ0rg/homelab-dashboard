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
