// The Network tab's pages. Overview is the whole network in one window: what is
// answering, how fast the internet is and who is using it, DNS, the switch. The
// rest are the tools that need a screen of their own: the check manager, the DNS
// device list, bandwidth over time, and the two that look at the LAN from one
// host (a scan, and the watch for a rogue DHCP server or a stolen address) —
// those two share one entry, "LAN", with a switch between them. What one host's
// traffic looks like is on that host's page, under Hosts.

export function networkSections(checksBadge) {
  return [
    ["overview", "Overview", null],
    ["checks", "Uptime", checksBadge],
    ["dns", "DNS", null],
    ["bandwidth", "Bandwidth", null],
    ["scan", "LAN", null],
  ];
}

// The address can name a page the row folds into an entry.
const LAN = ["scan", "watch"];
export const SECTION_VIEWS = { scan: [["scan", "Scan"], ["watch", "Watch"]] };

// The address's second half is a page, or a page and the one thing open in it
// (`checks/k5`: the Uptime page with that check selected).
export function parseSection(wanted) {
  const [section = "", detail = ""] = String(wanted || "").split("/");
  return { section, detail };
}

export function sectionAddress(section, detail) {
  return detail ? `${section}/${detail}` : section;
}

// The page to show for the address: itself, or the first entry when there is no
// such page (an old address such as the Switch, which is part of Overview now).
export function pickSection(sections, wanted) {
  const { section } = parseSection(wanted);
  return sections.some(([id]) => id === section) || LAN.includes(section) ? section : sections[0][0];
}

// The row entry a page lights up.
export function entryOf(section) {
  return LAN.includes(section) ? "scan" : section;
}

// Sections that look at the LAN from one server, so they show the server picker.
export const PER_HOST = ["scan", "watch"];
