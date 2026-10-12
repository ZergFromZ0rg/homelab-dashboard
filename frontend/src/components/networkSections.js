// The Network tab's sections: the network as a whole. What is answering, what
// DNS is doing, how fast the internet is and who is using it, the switch, and
// the two tools that look at the LAN from one host (a scan, and the watch for
// a rogue DHCP server or a stolen address). What one host's traffic looks like
// is on that host's page, under Hosts.

export function networkSections(checksBadge) {
  return [
    ["checks", "Uptime", checksBadge],
    ["dns", "DNS", null],
    ["bandwidth", "Bandwidth", null],
    ["switch", "Switch", null],
    ["scan", "Scan", null],
    ["watch", "Watch", null],
  ];
}

// The section in the address, unless there is no such section: then the first.
export function pickSection(sections, wanted) {
  return sections.some(([id]) => id === wanted) ? wanted : sections[0][0];
}

// Sections that look at the LAN from one server, so they show the server picker.
export const PER_HOST = ["scan", "watch"];
