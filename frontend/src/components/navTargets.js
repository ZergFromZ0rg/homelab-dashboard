import { hostsSub } from "./hostsNav";
import { issueSection } from "./networkSummary";
import { sectionAddress } from "./networkSections";

// Where a "go look at X" lands. Links and commands anywhere in the app name a
// target — some of them the names the old tabs had (servers, files, system,
// terminal, packets) — and this says which tab and which page of it that is
// now. `sub: null` means "the tab's Overview".
//
// -> { tab, sub }

// What a link asked to do on a host, as the page that does it.
const ACTION_PAGE = { "os-updates": "manage", files: "storage", show: "summary" };

export function resolveTarget(target, { host, action, page, section, check } = {}) {
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
      // A check names its page: "checks/k5" opens Uptime with that check selected.
      return { tab: "network", sub: section || check ? sectionAddress(section ?? "checks", check) : null };
    default:
      return { tab: target, sub: null };
  }
}

// An issue's key -> the arguments for onNavigate: the page where it is explained
// and, usually, fixed. Host problems open that host, the network's open the page
// of the Network tab that shows them, backups and deployments their own tabs.
export function issueTarget(key) {
  if (/^(check|network|netwatch):/.test(key)) return ["network", issueSection(key)];
  if (key.startsWith("backup")) return ["backups"];
  if (key.startsWith("host:")) return ["hosts", { host: key.split(":")[1] }];
  if (key.startsWith("deploy:")) return ["hosts"];
  return ["containers"];
}
