// The view mode (simple / advanced / god), remembered per browser. The
// event lets every listener in this window follow a change.
const KEY = "homelab.viewMode";
const MODES = ["simple", "advanced", "god"];

function getMode() {
  try {
    const stored = localStorage.getItem(KEY);
    return MODES.includes(stored) ? stored : "simple";
  } catch {
    return "simple";
  }
}

function setMode(m) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // no storage: the mode still changes for this page
  }
  window.dispatchEvent(new Event("homelab:mode-changed"));
}

// Module-level functions, so they're stable across renders and effects that
// depend on them don't re-subscribe every tick.
export function useModeSelector() {
  return { getMode, setMode };
}
