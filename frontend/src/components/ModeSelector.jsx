import { useEffect } from "react";

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
    } catch {}
    // Trigger storage event so other tabs sync, and custom event for same window
    window.dispatchEvent(new Event("homelab:mode-changed"));
  };

  return { getMode, setMode };
}

function ModeSelector({ mode, onSetMode }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Opt+1, Opt+2, Opt+3
      if (e.altKey && e.key === "1") { e.preventDefault(); onSetMode("simple"); }
      if (e.altKey && e.key === "2") { e.preventDefault(); onSetMode("advanced"); }
      if (e.altKey && e.key === "3") { e.preventDefault(); onSetMode("god"); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSetMode]);

  return (
    <div className={`mode-selector mode-selector--${mode}`}>
      <button 
        className={`mode-btn ${mode === "simple" ? "active" : ""}`}
        onClick={() => onSetMode("simple")}
        title="Simple (Morning) [⌥1]"
      >
        <span aria-hidden="true">☀️</span> Simple
      </button>
      <button 
        className={`mode-btn ${mode === "advanced" ? "active" : ""}`}
        onClick={() => onSetMode("advanced")}
        title="Advanced [⌥2]"
      >
        <span aria-hidden="true">⚙️</span> Advanced
      </button>
      <button 
        className={`mode-btn mode-btn--god ${mode === "god" ? "active" : ""}`}
        onClick={() => onSetMode("god")}
        title="God Mode [⌥3]"
      >
        <span aria-hidden="true">⚡</span> God Mode
      </button>
    </div>
  );
}

export default ModeSelector;
