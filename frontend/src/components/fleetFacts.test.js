import { describe, expect, it } from "vitest";
import { busiest, hostFacts } from "./fleetFacts";

const machine = (over = {}) => ({ online: true, uptime: 41 * 86400 + 3600, temperature: 58, host_facts: {}, ...over });
const ids = (facts) => facts.map((f) => f.id);

describe("hostFacts", () => {
  it("says how long it has been up and how warm it is, and nothing else when there is nothing to say", () => {
    const facts = hostFacts(machine());
    expect(facts.map((f) => f.text)).toEqual(["up 41d 1h", "58°C"]);
    expect(facts.every((f) => f.tone === null)).toBe(true);
  });

  it("adds what needs a look: updates (amber when some are security), a reboot, failed services", () => {
    const facts = hostFacts(machine({ host_facts: { os_updates: 12, security_updates: 3, reboot_required: true, failed_units: ["nginx.service"] } }));
    expect(ids(facts)).toEqual(["up", "temp", "updates", "reboot", "failed"]);
    const by = Object.fromEntries(facts.map((f) => [f.id, f]));
    expect(by.updates).toMatchObject({ text: "12 updates", tone: "warn" });
    expect(by.reboot.tone).toBe("warn");
    expect(by.failed).toMatchObject({ text: "1 failed", tone: "bad" });
    expect(by.failed.title).toContain("nginx.service");
  });

  it("keeps plain updates quiet", () => {
    const [updates] = hostFacts(machine({ host_facts: { os_updates: 1, security_updates: 0 } })).filter((f) => f.id === "updates");
    expect(updates).toMatchObject({ text: "1 update", tone: null });
  });

  it("warns about a hot machine", () => {
    expect(hostFacts(machine({ temperature: 86 })).find((f) => f.id === "temp").tone).toBe("warn");
  });

  it("leaves out what it doesn't know, and says nothing for a machine that is off", () => {
    expect(ids(hostFacts(machine({ uptime: null, temperature: null })))).toEqual([]);
    expect(hostFacts(machine({ online: false }))).toEqual([]);
    expect(hostFacts(undefined)).toEqual([]);
  });
});

describe("busiest", () => {
  const c = (name, status, cpu, ram) => ({ id: name, name, status, stats: { cpu_percent: cpu, memory: { used_bytes: ram } } });
  const fleet = {
    bigboy: [c("jellyfin", "running", 22.5, 1.4e9), c("doc-service", "running", 186, 9.8e9), c("old", "exited", 90, 1e9)],
    thinkpad: [c("grafana", "running", 3, 2.1e8), { id: "x", name: "nostats", status: "running" }],
  };

  it("ranks the running containers of every server by CPU, with a share of the biggest", () => {
    const rows = busiest(fleet, "cpu");
    expect(rows.map((r) => [r.name, r.host, r.value])).toEqual([
      ["doc-service", "bigboy", 186],
      ["jellyfin", "bigboy", 22.5],
      ["grafana", "thinkpad", 3],
    ]);
    expect(rows[0].share).toBe(1);
    expect(rows[1].share).toBeCloseTo(22.5 / 186, 5);
  });

  it("ranks by memory when asked, and stops at the limit", () => {
    expect(busiest(fleet, "memory").map((r) => r.name)).toEqual(["doc-service", "jellyfin", "grafana"]);
    expect(busiest(fleet, "memory", 2)).toHaveLength(2);
  });

  it("has nothing to rank, and no bars, when nothing reports", () => {
    expect(busiest({}, "cpu")).toEqual([]);
    expect(busiest({ a: [c("idle", "running", 0, 0)] }, "cpu")[0].share).toBe(0);
  });
});
