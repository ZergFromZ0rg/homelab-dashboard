// Each tab gets its own identity color (the tab's dot and active pill, and
// the page's backdrop glow while it's open), so which-tab-am-I-on becomes a
// color you recognize, not just text you read — teal stays Overview's (the
// existing --accent), the rest are picked to stay clear of green/red/amber
// (already online/offline/warning elsewhere in the app).
//
// Must also stay clear of hostColor.js's HOST_COLORS palette — a tab and
// a host are two different identity signals that happen to share screen
// space (e.g. a host chip next to the Containers tab), so an exact color
// match between them would misread as "this tab is that host".
//
// Plain hexes (not var(--accent)) so CSS can color-mix and animate them.
// Every tab has its own (Files, System and Terminal used to fall back to
// Overview's teal, so three tabs looked like one). Backups moved off
// #7dd3fc, which was a lighter twin of Containers' sky blue.
export const TAB_COLORS = {
  overview: "#2dd4bf", // teal
  containers: "#38bdf8", // sky
  files: "#e2c08d", // sand
  backups: "#a5b4fc", // periwinkle
  network: "#c4b5fd", // violet
  system: "#f0abfc", // orchid
  terminal: "#cbd5e1", // slate
};

export function tabColor(tab) {
  return TAB_COLORS[tab] || TAB_COLORS.overview;
}
