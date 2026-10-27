import { allContainers } from "./allContainers";
import { formatUptime } from "./machineInfo";

// What the fleet overview says about each server beyond its three meters, and who
// is using the most. Plain functions of the snapshot.

const HOT_C = 80;

// The one line under a server's meters: how long it has been up and how warm it is
// (quiet), then only what needs a look — pending OS updates, a reboot due, failed
// services. Each token is { id, text, tone, title }; tone is "bad", "warn" or null.
export function hostFacts(machine) {
  if (!machine?.online) return [];
  const facts = machine.host_facts ?? {};
  const out = [];

  if (machine.uptime != null) out.push({ id: "up", text: `up ${formatUptime(machine.uptime)}`, tone: null, title: "Time since the last boot" });
  if (typeof machine.temperature === "number") {
    const hot = machine.temperature >= HOT_C;
    out.push({ id: "temp", text: `${Math.round(machine.temperature)}°C`, tone: hot ? "warn" : null, title: hot ? "Running hot" : "Hottest sensor" });
  }
  if (facts.os_updates > 0) {
    const security = facts.security_updates || 0;
    out.push({
      id: "updates",
      text: `${facts.os_updates} update${facts.os_updates === 1 ? "" : "s"}`,
      tone: security > 0 ? "warn" : null,
      title: security > 0 ? `${facts.os_updates} OS updates waiting, ${security} of them security fixes` : `${facts.os_updates} OS updates waiting`,
    });
  }
  if (facts.reboot_required) out.push({ id: "reboot", text: "reboot due", tone: "warn", title: "An update needs a reboot to take effect" });
  const failed = facts.failed_units?.length ?? 0;
  if (failed > 0) out.push({ id: "failed", text: `${failed} failed`, tone: "bad", title: `Failed services: ${facts.failed_units.join(", ")}` });
  return out;
}

const VALUE = {
  cpu: (c) => c.stats?.cpu_percent,
  memory: (c) => c.stats?.memory?.used_bytes,
};

// The running containers that use the most CPU (or memory) across every server,
// biggest first, each with its share of the biggest one so a bar can be drawn.
export function busiest(containers, by = "cpu", limit = 6) {
  const read = VALUE[by] ?? VALUE.cpu;
  const rows = allContainers(containers)
    .filter((c) => c.status === "running" && typeof read(c) === "number")
    .map((c) => ({ id: c.id, name: c.name, host: c.host, value: read(c) }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit);
  const top = rows[0]?.value || 0;
  return rows.map((row) => ({ ...row, share: top > 0 ? row.value / top : 0 }));
}
