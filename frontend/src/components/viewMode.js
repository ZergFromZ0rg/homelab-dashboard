// The view mode (simple / advanced / god), remembered per browser. The
// event lets every listener in this window follow a change.
export function useModeSelector() {
  const getMode = () => {
    try {
      return localStorage.getItem("homelab.viewMode") || "simple";
    } catch {
      return "simple";
    }
  };

  const setMode = (m) => {
    try {
      localStorage.setItem("homelab.viewMode", m);
    } catch {
      // no storage: the mode still changes for this page
    }
    // Trigger storage event so other tabs sync, and custom event for same window
    window.dispatchEvent(new Event("homelab:mode-changed"));
  };

  return { getMode, setMode };
}
