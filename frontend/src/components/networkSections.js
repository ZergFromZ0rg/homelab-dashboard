// The Network tab's sections per mode.
//
// Advanced gets the essentials, look-only: what is answering, who is on the
// network, the switch, and the host's traffic. God gets everything: scans,
// connections, packet capture and the watch as well, plus the controls.

export function networkSections(essential, checksBadge) {
  if (essential) {
    return [
      ["checks", "Checks", checksBadge],
      ["dns", "DNS", null],
      ["switch", "Switch", null],
      ["network", "Host network", null],
    ];
  }
  return [
    ["network", "Host network", null],
    ["devices", "Scans", null],
    ["connections", "Connections", null],
    ["packets", "Packets", null],
    ["watch", "Watch", null],
    ["dns", "DNS", null],
    ["switch", "Switch", null],
    ["checks", "Service checks", checksBadge],
  ];
}

// The section remembered from last time, unless this mode doesn't offer it
// (Packets saved in God, then Advanced): then the first one.
export function pickSection(sections, saved) {
  return sections.some(([id]) => id === saved) ? saved : sections[0][0];
}

// Sections that show one server at a time, with the server picker.
export const PER_HOST = ["network", "devices", "connections", "packets", "watch"];
