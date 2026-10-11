import { describe, expect, it } from "vitest";
import { coverageNote } from "./piholeHistoryApi";

const range = (spanDays, coveredSeconds) => ({ start: 0, end: spanDays * 86400, covers_seconds: coveredSeconds });

describe("coverageNote", () => {
  it("says nothing when the database covers the range", () => {
    expect(coverageNote(range(7, 7 * 86400))).toBeNull();
    expect(coverageNote(range(7, 6.5 * 86400))).toBeNull();
  });

  it("says how much there is when Pi-hole is younger than the range", () => {
    expect(coverageNote(range(90, 3 * 86400))).toBe("Pi-hole has 3 days of history so far");
    expect(coverageNote(range(90, 1.5 * 86400))).toBe("Pi-hole has 1.5 days of history so far");
  });

  it("switches to hours under a day, and never says 0", () => {
    expect(coverageNote(range(7, 5 * 3600))).toBe("Pi-hole has 5 hours of history so far");
    expect(coverageNote(range(7, 600))).toBe("Pi-hole has 1 hours of history so far");
  });

  it("has nothing to say before the data arrives", () => {
    expect(coverageNote(null)).toBeNull();
  });
});
