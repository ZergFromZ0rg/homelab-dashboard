// A check "behind" a down dependency is failing too, but the dependency is
// the news: counts and badges use the root causes only.
export const isRootDown = (c) => c.status === "down" && !c.suppressed_by;
export const isBehind = (c) => c.status === "down" && Boolean(c.suppressed_by);
export const isAnswering = (c) => c.status === "up" || c.status === "degraded";

// Rows grouped by `group` (ungrouped last), each group's roots first and a
// check's dependents right under it. Worst status leads at every level.
const RANK = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
const byWorst = (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name);

export function arrange(checks) {
  const byGroup = new Map();
  for (const c of checks) {
    const key = c.group ?? "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }

  const groups = [...byGroup.entries()].map(([name, members]) => {
    const ids = new Set(members.map((m) => m.id));
    const kids = new Map();
    for (const m of members) {
      if (m.parent && ids.has(m.parent)) {
        if (!kids.has(m.parent)) kids.set(m.parent, []);
        kids.get(m.parent).push(m);
      }
    }
    const rows = [];
    const walk = (c, depth) => {
      rows.push({ check: c, depth });
      for (const k of (kids.get(c.id) ?? []).sort(byWorst)) walk(k, depth + 1);
    };
    members
      .filter((m) => !(m.parent && ids.has(m.parent)))
      .sort(byWorst)
      .forEach((m) => walk(m, 0));
    return {
      name,
      rows,
      down: members.filter(isRootDown).length,
      slow: members.filter((m) => m.status === "degraded").length,
      worst: Math.min(...members.map((m) => RANK[m.status])),
    };
  });

  // Named groups, worst first; the ungrouped remainder always last.
  return groups.sort(
    (a, b) => (a.name === "") - (b.name === "") || a.worst - b.worst || a.name.localeCompare(b.name)
  );
}
