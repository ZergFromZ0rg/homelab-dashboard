import { describe, expect, it } from "vitest";
import { arrange, isBehind, isRootDown } from "./checkStatus";

const c = (id, name, status, extra = {}) => ({ id, name, status, group: null, parent: null, suppressed_by: null, ...extra });

describe("checkStatus", () => {
  it("counts only root causes as down", () => {
    const router = c("r", "router", "down");
    const kid = c("k", "jelly", "down", { suppressed_by: { id: "r", name: "router" } });
    expect([router, kid].filter(isRootDown)).toEqual([router]);
    expect([router, kid].filter(isBehind)).toEqual([kid]);
  });

  it("groups, nests dependents under their parent, worst first, ungrouped last", () => {
    const list = [
      c("a", "alpha", "up", { group: "Z" }),
      c("loose", "loose", "down"),
      c("r", "router", "up", { group: "Net" }),
      c("s", "switch", "down", { group: "Net", parent: "r" }),
      c("p", "pihole", "degraded", { group: "Net" }),
    ];
    const groups = arrange(list);
    expect(groups.map((g) => g.name)).toEqual(["Net", "Z", ""]);
    // pihole (degraded) sorts before router (up); the switch hangs under the router
    expect(groups[0].rows.map((r) => [r.check.name, r.depth])).toEqual([
      ["pihole", 0], ["router", 0], ["switch", 1],
    ]);
    expect(groups[0]).toMatchObject({ down: 1, slow: 1 });
  });

  it("keeps a child whose parent lives in another group at the top of its own group", () => {
    const groups = arrange([c("r", "router", "up", { group: "A" }), c("k", "kid", "up", { group: "B", parent: "r" })]);
    expect(groups.find((g) => g.name === "B").rows[0].depth).toBe(0);
  });
});
