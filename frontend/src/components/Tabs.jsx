import { useEffect, useRef } from "react";

// Each tab gets its own identity color (the active underline/label), so
// which-tab-am-I-on becomes a color you recognize, not just text you
// read — teal stays Overview's (the existing --accent), the rest are
// picked to stay clear of green/red/amber (already online/offline/
// warning elsewhere in the app). Falls back to --accent for any tab not
// listed here.
//
// Must also stay clear of hostColor.js's HOST_COLORS palette — a tab and
// a host are two different identity signals that happen to share screen
// space (e.g. a host chip next to the Containers tab), so an exact color
// match between them would misread as "this tab is that host".
const TAB_COLORS = {
  overview: "var(--accent)",
  servers: "#a5b4fc",
  containers: "#38bdf8",
  services: "#c4b5fd",
  deploy: "#f0abfc",
  personal: "#fda4af",
};

// tab: { value, label, count?, tone? } — `tone: "bad"` paints the count as
// an alert (e.g. open issues on Overview).
function Tabs({ tabs, active, onChange }) {
  const navRef = useRef(null);

  // On a phone the bar scrolls sideways; keep the current tab in view.
  useEffect(() => {
    navRef.current
      ?.querySelector(".tab.active")
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [active]);

  return (
    <nav className="tabs" aria-label="Sections" ref={navRef}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          className={`tab ${active === tab.value ? "active" : ""}`}
          style={{ "--tab-color": TAB_COLORS[tab.value] || "var(--accent)" }}
          aria-current={active === tab.value ? "page" : undefined}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count != null && (
            <span className={`tab-count ${tab.tone ? `tab-count--${tab.tone}` : ""}`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

export default Tabs;
