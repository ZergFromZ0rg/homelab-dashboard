import { useEffect } from "react";

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
        type="button"
        className={`mode-btn ${mode === "simple" ? "active" : ""}`}
        onClick={() => onSetMode("simple")}
        title="Briefing, overview and personal on one page (⌥1)"
      >
        Simple
      </button>
      <button
        type="button"
        className={`mode-btn ${mode === "advanced" ? "active" : ""}`}
        onClick={() => onSetMode("advanced")}
        title="Overview with every server, Containers, Backups (⌥2)"
      >
        Advanced
      </button>
      <button
        type="button"
        className={`mode-btn mode-btn--god ${mode === "god" ? "active" : ""}`}
        onClick={() => onSetMode("god")}
        title="Advanced plus Network and shells (⌥3)"
      >
        God
      </button>
    </div>
  );
}

export default ModeSelector;
