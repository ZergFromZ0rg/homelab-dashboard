import { describe, expect, it } from "vitest";
import { containerStrip, failedServices } from "./hostHealth";

const box = (name, over = {}) => ({ id: name, name, status: "running", health: null, restart_count: 0, ...over });

describe("containerStrip", () => {
  it("counts what runs and lists a dot per container, failing first and stopped last", () => {
    const strip = containerStrip([
      box("plex"),
      box("old-job", { status: "exited" }),
      box("nextcloud", { health: "unhealthy" }),
      box("grafana"),
    ]);
    expect(strip).toMatchObject({ total: 4, running: 3, stopped: 1 });
    expect(strip.items.map((i) => [i.name, i.tone])).toEqual([
      ["nextcloud", "bad"],
      ["grafana", "ok"],
      ["plex", "ok"],
      ["old-job", "off"],
    ]);
  });

  it("names the ones that need a look and why, the way the Containers tab marks them", () => {
    const strip = containerStrip([box("a", { health: "unhealthy" }), box("b", { restart_count: 7 }), box("c", { restart_count: 2 })]);
    expect(strip.problems).toEqual([
      { id: "a", name: "a", reason: "unhealthy" },
      { id: "b", name: "b", reason: "restarted 7×" },
    ]);
  });

  it("uses the restart threshold it is given", () => {
    const list = [box("a", { restart_count: 3 })];
    expect(containerStrip(list).problems).toEqual([]);
    expect(containerStrip(list, 3).problems).toHaveLength(1);
  });

  it("does not call a stopped container a problem", () => {
    const strip = containerStrip([box("batch", { status: "exited" })]);
    expect(strip.problems).toEqual([]);
    expect(strip.items[0]).toMatchObject({ tone: "off", title: "batch — exited" });
  });

  it("copes with a host that has none, or none yet", () => {
    expect(containerStrip([])).toMatchObject({ total: 0, running: 0, items: [], problems: [] });
    expect(containerStrip(undefined).total).toBe(0);
  });
});

describe("failedServices", () => {
  it("lists the failed units without .service", () => {
    expect(failedServices({ host_facts: { failed_units: ["nginx.service", "snapd.socket"] } })).toEqual([
      { unit: "nginx.service", label: "nginx" },
      { unit: "snapd.socket", label: "snapd.socket" },
    ]);
  });

  it("is an empty list when none failed, and null when the agent doesn't say", () => {
    expect(failedServices({ host_facts: { failed_units: [] } })).toEqual([]);
    expect(failedServices({ host_facts: {} })).toBeNull();
    expect(failedServices({})).toBeNull();
    expect(failedServices(undefined)).toBeNull();
  });
});
