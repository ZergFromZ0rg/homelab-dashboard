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
  system: "var(--main-host)",
  containers: "#38bdf8",
  deploy: "#f0abfc",
};

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          className={`tab ${active === tab.value ? "active" : ""}`}
          style={{ "--tab-color": TAB_COLORS[tab.value] || "var(--accent)" }}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default Tabs;
