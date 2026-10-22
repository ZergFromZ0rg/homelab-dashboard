import { describe, expect, it } from "vitest";
import { entryOf, networkSections, parseSection, pickSection, PER_HOST, sectionAddress, SECTION_VIEWS } from "./networkSections";

const ids = (sections) => sections.map(([id]) => id);

describe("networkSections", () => {
  it("is the whole network in one window, then the tools that need a screen", () => {
    expect(ids(networkSections(null))).toEqual(["overview", "checks", "dns", "bandwidth", "scan"]);
  });

  it("opens on the Overview, not on one slice of it", () => {
    expect(networkSections(null)[0][0]).toBe("overview");
  });

  it("has no Switch page: the switch is a panel of the Overview", () => {
    expect(ids(networkSections(null))).not.toContain("switch");
  });

  it("carries the problem badge on the checks section", () => {
    expect(networkSections("2 down").find(([id]) => id === "checks")[2]).toBe("2 down");
    expect(networkSections(null).find(([id]) => id === "checks")[2]).toBeNull();
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
    expect(pickSection(networkSections(null), "checks")).toBe("checks");
  });

  it("still opens the watch from its old address", () => {
    expect(pickSection(networkSections(null), "watch")).toBe("watch");
  });

  it("falls back to the Overview for one that doesn't (the old Switch page, a bad address)", () => {
    expect(pickSection(networkSections(null), "switch")).toBe("overview");
    expect(pickSection(networkSections(null), "packets")).toBe("overview");
    expect(pickSection(networkSections(null), "")).toBe("overview");
    expect(pickSection(networkSections(null), undefined)).toBe("overview");
  });

  it("reads the page out of an address that also names what is open in it", () => {
    expect(pickSection(networkSections(null), "checks/k5")).toBe("checks");
  });
});

describe("parseSection and sectionAddress", () => {
  it("split and join the page and the thing open in it", () => {
    expect(parseSection("checks/k5")).toEqual({ section: "checks", detail: "k5" });
    expect(parseSection("dns")).toEqual({ section: "dns", detail: "" });
    expect(parseSection("")).toEqual({ section: "", detail: "" });
    expect(parseSection(undefined)).toEqual({ section: "", detail: "" });
    expect(sectionAddress("checks", "k5")).toBe("checks/k5");
    expect(sectionAddress("dns")).toBe("dns");
  });
});
