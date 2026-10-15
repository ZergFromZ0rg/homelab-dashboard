// The Network tab's sections: the network as a whole. What is answering, what
// DNS is doing, how fast the internet is and who is using it, the switch, and
// the two tools that look at the LAN from one host (a scan, and the watch for
// a rogue DHCP server or a stolen address) — those two share one entry, "LAN",
// with a switch between them. What one host's traffic looks like is on that
// host's page, under Hosts.

export function networkSections(checksBadge) {
  return [
    ["checks", "Uptime", checksBadge],
    ["dns", "DNS", null],
    ["bandwidth", "Bandwidth", null],
    ["switch", "Switch", null],
    ["scan", "LAN", null],
  ];
}

// The address can name a page the row folds into an entry.
const LAN = ["scan", "watch"];
export const SECTION_VIEWS = { scan: [["scan", "Scan"], ["watch", "Watch"]] };

// The page to show for the section in the address: itself, or the first
// entry when there is no such page.
export function pickSection(sections, wanted) {
  return sections.some(([id]) => id === wanted) || LAN.includes(wanted) ? wanted : sections[0][0];
}

// The row entry a page lights up.
export function entryOf(section) {
  return LAN.includes(section) ? "scan" : section;
}

// Sections that look at the LAN from one server, so they show the server picker.
export const PER_HOST = ["scan", "watch"];
