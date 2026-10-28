import { HIGH_RESTART_COUNT, needsAttention } from "./containerSort";

// What a host's Health page says about the containers and services on it.
// Plain functions of the snapshot.

const TONE_ORDER = { bad: 0, ok: 1, off: 2 };

function reasonOf(container) {
  if (container.health === "unhealthy") return "unhealthy";
  return `restarted ${container.restart_count}×`;
}

// One dot per container — a failing one "bad", a running one "ok", the rest "off"
// (stopped, which is often on purpose) — and the failing ones named with why.
// { total, running, stopped, items: [{ id, name, tone, title }], problems: [{ id, name, reason }] }
export function containerStrip(containers, restartThreshold = HIGH_RESTART_COUNT) {
  const items = (containers ?? [])
    .map((c) => {
      const running = c.status === "running";
      const bad = needsAttention(c, restartThreshold);
      const tone = bad ? "bad" : running ? "ok" : "off";
      const state = bad ? reasonOf(c) : running ? "running" : c.status || "stopped";
      return { id: c.id ?? c.name, name: c.name, tone, title: `${c.name} — ${state}`, reason: bad ? reasonOf(c) : null };
    })
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.name.localeCompare(b.name));

  return {
    total: items.length,
    running: (containers ?? []).filter((c) => c.status === "running").length,
    stopped: items.filter((i) => i.tone === "off").length,
    items: items.map(({ id, name, tone, title }) => ({ id, name, tone, title })),
    problems: items.filter((i) => i.reason).map(({ id, name, reason }) => ({ id, name, reason })),
  };
}

// The services systemd marks failed on this host, as [{ unit, label }] (the label
// drops ".service"). null when the agent doesn't report them, so a page can say
// nothing rather than claim they are fine.
export function failedServices(machine) {
  const units = machine?.host_facts?.failed_units;
  if (!Array.isArray(units)) return null;
  return units.map((unit) => ({ unit, label: unit.replace(/\.service$/, "") }));
}
