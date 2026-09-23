import { useEffect, useRef } from "react";
import { tabColor } from "./tabColors";

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
          style={{ "--tab-color": tabColor(tab.value) }}
          aria-current={active === tab.value ? "page" : undefined}
          onClick={() => onChange(tab.value)}
        >
          <span className="tab-dot" aria-hidden="true" />
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
