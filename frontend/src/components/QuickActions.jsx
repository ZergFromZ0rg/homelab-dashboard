import { pinKey } from "./containerPins";

// One-click restart/stop for the containers you've pinned, plus jumps to
// the tabs where the rest of the actions live.

function QuickActions({ pins, containers, onControl, onNavigate }) {
  const pinned = new Set(pins);
  const targets = [];
  for (const [host, list] of Object.entries(containers)) {
    for (const c of list) {
      if (pinned.has(pinKey(host, c.name))) targets.push({ host, ...c });
    }
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));

  const busy = (t) => Boolean(onControl.pending[`${t.host}-${t.id}`]);

  return (
    <div className="quick-actions">
      {targets.length === 0 ? (
        <p className="overview-empty">
          Pin a container (★ on its row in the Containers tab) for one-click
          restart here.
        </p>
      ) : (
        <div className="qa-group">
          {targets.map((t) => (
            <div key={`${t.host}-${t.id}`} className="qa-target">
              <span className="qa-name">{t.name}</span>
              <button
                type="button"
                className="qa-btn"
                disabled={busy(t)}
                onClick={() => {
                  if (window.confirm(`Restart ${t.name} on ${t.host}?`))
                    onControl.run(t.host, t.id, "restart");
                }}
              >
                {busy(t) ? "…" : "Restart"}
              </button>
              {t.status === "running" && (
                <button
                  type="button"
                  className="qa-btn"
                  disabled={busy(t)}
                  onClick={() => {
                    if (window.confirm(`Stop ${t.name} on ${t.host}?`))
                      onControl.run(t.host, t.id, "stop");
                  }}
                >
                  Stop
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="qa-group qa-group--nav">
        <button type="button" className="qa-btn" onClick={() => onNavigate("deploy")}>
          Deploy →
        </button>
        <button
          type="button"
          className="qa-btn"
          onClick={() => onNavigate("containers")}
        >
          Containers →
        </button>
      </div>
    </div>
  );
}

export default QuickActions;
