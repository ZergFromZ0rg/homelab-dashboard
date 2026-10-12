import { hostsSub } from "./hostsNav";

// Where a "go look at X" lands. Links and commands anywhere in the app name a
// target — some of them the names the old tabs had (servers, files, system,
// terminal, packets) — and this says which tab and which page of it that is
// now. `sub: null` means "the page that tab was last on".
//
// -> { tab, sub }

// What a link asked to do on a host, as the page that does it.
const ACTION_PAGE = { "os-updates": "manage", files: "storage", show: "summary" };

export function resolveTarget(target, { host, action, page, section } = {}) {
  const hostPage = (fallback) => page ?? ACTION_PAGE[action] ?? fallback;

  switch (target) {
    case "hosts":
      return { tab: "hosts", sub: host ? hostsSub(host, hostPage("summary")) : null };
    case "overview":
    case "servers":
    case "deploy":
      return { tab: "hosts", sub: host ? hostsSub(host, hostPage("summary")) : "overview" };
    case "files":
      return { tab: "hosts", sub: host ? hostsSub(host, "storage") : "storage" };
    case "system":
      return { tab: "hosts", sub: host ? hostsSub(host, "services") : "services" };
    case "terminal":
      return { tab: "hosts", sub: host ? hostsSub(host, "summary") : null };
    case "packets":
      return { tab: "hosts", sub: host ? hostsSub(host, "packets") : "packets" };
    case "network":
      return { tab: "network", sub: section ?? null };
    default:
      return { tab: target, sub: null };
  }
}
