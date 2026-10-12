import { useLayoutEffect, useRef, useState } from "react";
import { tabColor } from "./tabColors";

// tab: { value, label, count?, tone? } — `tone: "bad"` paints the count as
// an alert (e.g. open issues on Overview).
//
// One pill sits behind the active tab and slides to the next one: its
// position is measured from the tab itself, so labels and counts of any
// width work, and it re-measures when a count changes a tab's width.
function Tabs({ tabs, active, onChange }) {
  const navRef = useRef(null);
  const [pill, setPill] = useState(null);
  const moved = useRef(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const measure = () => {
      const el = nav.querySelector(".tab.active");
      if (!el) return setPill(null);
      setPill((prev) => {
        const next = { x: el.offsetLeft, w: el.offsetWidth };
        return prev && prev.x === next.x && prev.w === next.w ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    nav.querySelectorAll(".tab").forEach((t) => ro.observe(t));
    return () => ro.disconnect();
  }, [active, tabs.length]);

  // On a phone the bar scrolls sideways; keep the current tab in view.
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector(".tab.active");
    if (!el || !moved.current) {
      moved.current = true;
      return;
    }
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <nav className="tabs" aria-label="Sections" ref={navRef}>
      {pill && (
        <span
          className="tab-indicator"
          aria-hidden="true"
          style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px`, "--tab-color": tabColor(active) }}
        />
      )}
      {tabs.map((tab, i) => (
        <button
          key={tab.value}
          type="button"
          className={`tab ${active === tab.value ? "active" : ""}`}
          style={{ "--tab-color": tabColor(tab.value), "--i": i }}
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
