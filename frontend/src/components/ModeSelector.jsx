import { useEffect } from "react";

const MODES = [
  { value: "simple", label: "Simple", key: "1", title: "Briefing, overview and personal on one page" },
  { value: "advanced", label: "Advanced", key: "2", title: "Overview with every server, Containers, Files, Backups" },
  { value: "god", label: "God", key: "3", title: "Advanced plus Network, System, Terminal and shells" },
];

// Three equal segments and one thumb that slides between them (CSS moves
// it from the mode class), tinted per mode: neutral, teal, red for God.
function ModeSelector({ mode, onSetMode }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      // ⌥-digits type characters (™, £, …) in a field; leave those alone.
      const t = e.target;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // e.code, not e.key: on a Mac, ⌥1 types "¡".
      const hit = MODES.find((m) => e.code === `Digit${m.key}`);
      if (!hit) return;
      e.preventDefault();
      onSetMode(hit.value);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSetMode]);

  return (
    <div className={`mode-selector mode-selector--${mode}`} role="group" aria-label="View mode">
      <span className="mode-thumb" aria-hidden="true" />
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className={`mode-btn ${mode === m.value ? "active" : ""}`}
          aria-pressed={mode === m.value}
          onClick={() => mode !== m.value && onSetMode(m.value)}
          title={`${m.title} (⌥${m.key})`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export default ModeSelector;
