import { describe, expect, it } from "vitest";
import { configBackup, openStacks, protection } from "./recovery";

const item = (name, bytes, over = {}) => ({ kind: "volume", name, bytes, protected_by: null, ignored: null, partial: false, ...over });
const stack = (project, items) => ({ project, items });

const recovery = (projects, over = {}) => ({
  host: "bigboy",
  config_backup: { state: "ok", last_success_age: 7200 },
  projects,
  unprotected_bytes: 0,
  ignored_count: 0,
  ...over,
});

describe("configBackup", () => {
  it("words each state the agent can report, with how long ago when it has run", () => {
    expect(configBackup({ state: "ok", last_success_age: 7200 })).toMatchObject({ word: "Backed up", detail: "pushed 2h ago", tone: "ok" });
    expect(configBackup({ state: "stale", last_success_age: 30 * 3600 })).toMatchObject({ word: "Behind", tone: "warn" });
    expect(configBackup({ state: "failing", last_error: "push rejected" })).toMatchObject({ word: "Failing", detail: "push rejected", tone: "bad" });
    expect(configBackup({ state: "not_configured" })).toMatchObject({ word: "Not backed up", tone: "bad" });
    expect(configBackup({ state: "pending" }).tone).toBe("warn");
    expect(configBackup({ state: "disabled" }).tone).toBe("none");
  });

  it("says it couldn't ask when there is no report", () => {
    expect(configBackup(undefined)).toMatchObject({ state: "unknown", word: "Couldn't ask", tone: "none" });
  });
});

describe("openStacks", () => {
  it("lists the stacks with data nothing covers, biggest first, counting only what is open", () => {
    const stacks = openStacks(
      recovery([
        stack("jellyfin", [item("jellyfin_config", 184e6), item("/mnt/media", 900e9, { ignored: { reason: "re-acquirable" } })]),
        stack("grafana", [item("grafana-data", 96e6)]),
        stack("ai-librarian", [item("qdrant", 730e6, { protected_by: { job: "qdrant", state: "ok" } })]),
        stack("prometheus", [item("prom", 2e9, { partial: true })]),
      ])
    );
    expect(stacks.map((s) => [s.project, s.bytes])).toEqual([
      ["prometheus", 2e9],
      ["jellyfin", 184e6],
      ["grafana", 96e6],
    ]);
    expect(stacks[0].partial).toBe(true);
    expect(stacks[1].partial).toBe(false);
  });

  it("leaves out a stack that was skipped as a whole or has nothing left to decide", () => {
    const stacks = openStacks(
      recovery([
        { ...stack("portainer", [item("portainer_data", 9e6)]), ignored: { reason: "replaced by this dashboard" } },
        { ...stack("done", [item("done_data", 5e6)]), settled: true },
        stack("grafana", [item("grafana-data", 96e6)]),
      ])
    );
    expect(stacks.map((s) => s.project)).toEqual(["grafana"]);
  });

  it("has none when everything is covered or skipped, or when there is no report", () => {
    expect(openStacks(recovery([stack("a", [item("v", 1, { protected_by: { job: "j" } })]), stack("b", [])]))).toEqual([]);
    expect(openStacks(null)).toEqual([]);
  });
});

describe("protection", () => {
  const ok = { state: "ok", last_success_age: 600 };

  it("is red and names the size when data is not backed up", () => {
    const p = protection({ backup: ok, recovery: recovery([stack("jellyfin", [item("v", 184_320_000)])], { unprotected_bytes: 184_320_000 }) });
    expect(p).toMatchObject({ tone: "bad", label: "176 MB at risk" });
    expect(p.stacks).toHaveLength(1);
  });

  it("is red without a compose backup, and says why", () => {
    expect(protection({ backup: { state: "failing" }, recovery: recovery([]) })).toMatchObject({ tone: "bad", label: "backup failing" });
    expect(protection({ backup: { state: "not_configured" }, recovery: recovery([]) })).toMatchObject({ tone: "bad", label: "no compose backup" });
  });

  it("is amber when the compose backup is behind", () => {
    expect(protection({ backup: { state: "stale", last_success_age: 99999 }, recovery: recovery([]) })).toMatchObject({ tone: "warn", label: "backup behind" });
  });

  it("is safe only when the compose files and every stack are covered", () => {
    expect(protection({ backup: ok, recovery: recovery([stack("a", [item("v", 1, { protected_by: { job: "j" } })])]) })).toMatchObject({ tone: "ok", label: "safe" });
  });

  it("does not claim safe before the report has come, and says when it never will", () => {
    expect(protection({ backup: ok })).toMatchObject({ tone: "none", label: "checking…", known: false });
    expect(protection({ backup: ok, failed: true })).toMatchObject({ tone: "none", label: "couldn't check", failed: true });
    // A compose backup that is failing is still news without the report.
    expect(protection({ backup: { state: "failing" } })).toMatchObject({ tone: "bad" });
  });

  it("falls back to the report's own word on the compose backup", () => {
    expect(protection({ recovery: recovery([], { config_backup: { state: "failing" } }) }).config.state).toBe("failing");
  });

  it("counts what was skipped on purpose", () => {
    expect(protection({ backup: ok, recovery: recovery([], { ignored_count: 2 }) }).ignored).toBe(2);
  });
});
