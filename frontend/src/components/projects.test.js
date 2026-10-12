import { describe, expect, it } from "vitest";
import { composeProjects } from "./projects";

const c = (name, project, extra = {}) => ({ name, compose_project: project, status: "running", started_at: "2026-10-11T10:00:00Z", ...extra });

describe("composeProjects", () => {
  it("groups containers by compose project and host, leaving out bare containers", () => {
    const projects = composeProjects({
      bigboy: [c("web", "media"), c("db", "media"), c("loner", null), c("web", "wiki")],
      thinkpad: [c("web", "media")],
    });
    expect(projects.map((p) => [p.host, p.name, p.total])).toEqual(
      expect.arrayContaining([["bigboy", "media", 2], ["bigboy", "wiki", 1], ["thinkpad", "media", 1]])
    );
    expect(projects).toHaveLength(3);
  });

  it("counts what is running and what has a newer image", () => {
    const [p] = composeProjects({
      bigboy: [c("a", "x"), c("b", "x", { status: "exited" }), c("d", "x", { update: { can_update: true } })],
    });
    expect([p.total, p.running, p.updates]).toEqual([3, 2, 1]);
    expect(p.containers).toEqual(["a", "b", "d"]);
  });

  it("calls an unhealthy or restarting project bad, a partly stopped one warn, the rest ok", () => {
    const tones = Object.fromEntries(
      composeProjects({
        h: [
          c("a", "sick", { health: "unhealthy" }),
          c("b", "loop", { status: "restarting" }),
          c("c", "half"), c("d", "half", { status: "exited" }),
          c("e", "fine"),
        ],
      }).map((p) => [p.name, p.tone])
    );
    expect(tones).toEqual({ sick: "bad", loop: "bad", half: "warn", fine: "ok" });
  });

  it("puts what needs a look first, then the most recently started", () => {
    const names = composeProjects({
      h: [
        c("a", "old", { started_at: "2026-09-01T00:00:00Z" }),
        c("b", "new", { started_at: "2026-10-11T00:00:00Z" }),
        c("c", "sick", { health: "unhealthy", started_at: "2026-08-01T00:00:00Z" }),
      ],
    }).map((p) => p.name);
    expect(names).toEqual(["sick", "new", "old"]);
  });

  it("takes the newest start of a project and ignores containers that never started", () => {
    const [p] = composeProjects({
      h: [c("a", "x", { started_at: "2026-10-01T00:00:00Z" }), c("b", "x", { started_at: "2026-10-05T00:00:00Z" }), c("c", "x", { started_at: "0001-01-01T00:00:00Z" })],
    });
    expect(p.newest).toBe(Date.parse("2026-10-05T00:00:00Z"));
  });

  it("copes with nothing", () => {
    expect(composeProjects({})).toEqual([]);
    expect(composeProjects(undefined)).toEqual([]);
  });
});
