// Each tab gets its own identity color (the active underline/label), so
// which-tab-am-I-on becomes a color you recognize, not just text you
// read — teal stays Overview's (the existing --accent), the rest are
// picked to stay clear of green/red/amber (already online/offline/
// warning elsewhere in the app). Falls back to --accent for any tab not
// listed here.
const TAB_COLORS = {
  overview: "var(--accent)",
  system: "var(--main-host)",
  containers: "#c084fc",
  deploy: "#f472b6",
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
