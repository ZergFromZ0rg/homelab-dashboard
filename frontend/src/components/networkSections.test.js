import { describe, expect, it } from "vitest";
import { entryOf, networkSections, pickSection, PER_HOST, SECTION_VIEWS } from "./networkSections";

const ids = (sections) => sections.map(([id]) => id);

describe("networkSections", () => {
  it("is the network as a whole, with nothing that belongs to one host", () => {
    expect(ids(networkSections(null))).toEqual(["checks", "dns", "bandwidth", "switch", "scan"]);
  });

  it("leads with the uptime checks, the thing you open it to see", () => {
    expect(networkSections(null)[0][0]).toBe("checks");
  });

  it("carries the down-count badge on the checks section", () => {
    expect(networkSections("2 down").find(([id]) => id === "checks")[2]).toBe("2 down");
  });

  it("asks which server only for the tools that look from one", () => {
    expect(PER_HOST).toEqual(["scan", "watch"]);
    for (const id of PER_HOST) expect(ids(networkSections(null)).map(entryOf)).toContain(entryOf(id));
  });

  it("puts the scan and the watch under one entry, with a switch between them", () => {
    expect(entryOf("scan")).toBe("scan");
    expect(entryOf("watch")).toBe("scan");
    expect(entryOf("dns")).toBe("dns");
    expect(SECTION_VIEWS.scan.map(([id]) => id)).toEqual(["scan", "watch"]);
  });
});

describe("pickSection", () => {
  it("keeps a section that exists", () => {
    expect(pickSection(networkSections(null), "dns")).toBe("dns");
  });

  it("still opens the watch from its old address", () => {
    expect(pickSection(networkSections(null), "watch")).toBe("watch");
  });

  it("falls back to the first for one that doesn't (an old address, a bad one)", () => {
    expect(pickSection(networkSections(null), "packets")).toBe("checks");
    expect(pickSection(networkSections(null), "")).toBe("checks");
    expect(pickSection(networkSections(null), undefined)).toBe("checks");
  });
});
