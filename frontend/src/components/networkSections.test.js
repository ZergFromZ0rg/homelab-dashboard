import { describe, expect, it } from "vitest";
import { networkSections, pickSection } from "./networkSections";

const ids = (sections) => sections.map(([id]) => id);

describe("networkSections", () => {
  it("gives Advanced the essentials and nothing that scans, captures or watches", () => {
    expect(ids(networkSections(true, null))).toEqual(["checks", "dns", "switch", "network"]);
  });

  it("gives God everything", () => {
    const god = ids(networkSections(false, null));
    for (const id of ["network", "devices", "connections", "packets", "watch", "dns", "switch", "checks"]) {
      expect(god).toContain(id);
    }
  });

  it("leads Advanced with the checks and God with the host network", () => {
    expect(networkSections(true, null)[0][0]).toBe("checks");
    expect(networkSections(false, null)[0][0]).toBe("network");
  });

  it("carries the down-count badge on the checks section in both", () => {
    for (const essential of [true, false]) {
      const checks = networkSections(essential, "2 down").find(([id]) => id === "checks");
      expect(checks[2]).toBe("2 down");
    }
  });
});

describe("pickSection", () => {
  it("keeps the remembered section when this mode offers it", () => {
    expect(pickSection(networkSections(true, null), "dns")).toBe("dns");
    expect(pickSection(networkSections(false, null), "packets")).toBe("packets");
  });

  it("falls back to the first when it does not (Packets saved in God, then Advanced)", () => {
    expect(pickSection(networkSections(true, null), "packets")).toBe("checks");
    expect(pickSection(networkSections(true, null), undefined)).toBe("checks");
  });
});
