import { describe, expect, it } from "vitest";
import { filterDevices, hiddenCount } from "./deviceFilter";

const devices = [
  { name: "bigboy", mac: "74:56", ip: "10.0.0.2", kind: "server", online: true, ghost: "" },
  { name: "iPhone", mac: "a8:bb", ip: "10.0.0.7", kind: "personal", online: false, ghost: "", notes: "dad's" },
  { name: "mystery", mac: "be:56", ip: "10.0.0.9", kind: "unknown", online: true, ghost: "" },
  { name: "pi.hole", mac: "ip-1", ip: "10.0.0.1", kind: "unknown", online: null, ghost: "own" },
];

describe("filterDevices", () => {
  it("hides ghosts unless asked, and counts them", () => {
    expect(filterDevices(devices)).toHaveLength(3);
    expect(filterDevices(devices, { showHidden: true })).toHaveLength(4);
    expect(hiddenCount(devices)).toBe(1);
  });

  it("filters by state and kind", () => {
    expect(filterDevices(devices, { filter: "online" }).map((d) => d.name)).toEqual(["bigboy", "mystery"]);
    expect(filterDevices(devices, { filter: "server" }).map((d) => d.name)).toEqual(["bigboy"]);
    expect(filterDevices(devices, { filter: "unknown" }).map((d) => d.name)).toEqual(["mystery"]);
  });

  it("searches name, address, notes", () => {
    expect(filterDevices(devices, { query: "DAD" }).map((d) => d.name)).toEqual(["iPhone"]);
    expect(filterDevices(devices, { query: "10.0.0.9" }).map((d) => d.name)).toEqual(["mystery"]);
  });
});
