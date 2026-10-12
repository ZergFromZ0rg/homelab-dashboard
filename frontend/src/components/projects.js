// The compose projects across the fleet, as one row each: a project is a
// group of containers that were brought up together, so it is the unit you
// think in ("jellyfin", "ai-librarian") rather than the container.

const startedMs = (container) => {
  if (container.status !== "running") return null;
  const value = container.started_at;
  if (!value || value.startsWith("0001-")) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const TONE_ORDER = { bad: 0, warn: 1, ok: 2 };

// -> [{ key, host, name, total, running, updates, newest, tone, containers }],
// the ones that need a look first, then the most recently (re)started.
// `newest` is when the last running container of the project started (ms), so
// a project that was just redeployed reads as freshly worked on.
export function composeProjects(containers) {
  const byKey = new Map();
  for (const [host, list] of Object.entries(containers || {})) {
    for (const c of list || []) {
      if (!c.compose_project) continue;
      const key = `${host}/${c.compose_project}`;
      if (!byKey.has(key)) byKey.set(key, { key, host, name: c.compose_project, members: [] });
      byKey.get(key).members.push(c);
    }
  }
  return [...byKey.values()]
    .map(({ members, ...project }) => {
      const running = members.filter((c) => c.status === "running").length;
      const unhealthy = members.some((c) => c.health === "unhealthy" || c.status === "restarting");
      const starts = members.map(startedMs).filter((ms) => ms != null);
      return {
        ...project,
        total: members.length,
        running,
        updates: members.filter((c) => c.update?.can_update).length,
        newest: starts.length ? Math.max(...starts) : null,
        tone: unhealthy ? "bad" : running < members.length ? "warn" : "ok",
        containers: members.map((c) => c.name),
      };
    })
    .sort(
      (a, b) =>
        TONE_ORDER[a.tone] - TONE_ORDER[b.tone] ||
        (b.newest ?? 0) - (a.newest ?? 0) ||
        a.name.localeCompare(b.name)
    );
}
