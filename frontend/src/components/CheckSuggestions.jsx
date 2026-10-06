import { useState } from "react";
import { acceptSuggestions, dismissSuggestions, fetchSuggestions } from "./checksApi";
import { usePolled } from "./usePolled";

const TYPE_LABEL = { http: "HTTP", tcp: "TCP", ping: "Ping" };

// "Nothing watches this yet": hosts and containers the dashboard already
// knows about, one tick away from being a check. Collapsed to a single line
// until asked, so a fleet with everything covered shows nothing at all.
function CheckSuggestions() {
  const { data } = usePolled(fetchSuggestions, "suggestions", 60_000);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null); // null = all
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const items = data?.suggestions ?? [];
  if (items.length === 0) return null;

  const chosen = (picked ?? new Set(items.map((i) => i.key)));
  const keys = items.filter((i) => chosen.has(i.key)).map((i) => i.key);

  const toggle = (key) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn(keys);
      setPicked(null);
      setOpen(items.length > keys.length);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div className="check-suggest">
      <button
        type="button"
        className="check-suggest-bar"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Hosts and containers nothing is checking yet"
      >
        <strong>{items.length}</strong> not monitored yet
        <span>{open ? "hide" : "review"}</span>
      </button>

      {open && (
        <div className="check-suggest-body">
          {groups.map((group) => (
            <div key={group} className="check-suggest-group">
              <span className="check-suggest-title">{group}</span>
              {items
                .filter((i) => i.group === group)
                .map((i) => (
                  <label key={i.key} className="check-suggest-row" title={i.reason}>
                    <input type="checkbox" checked={chosen.has(i.key)} onChange={() => toggle(i.key)} />
                    <strong>{i.name}</strong>
                    <span className="chip">{TYPE_LABEL[i.type]}</span>
                    <code>{i.target}</code>
                  </label>
                ))}
            </div>
          ))}
          {error && <p className="cred-error">{error}</p>}
          <div className="check-form-actions">
            <button type="button" className="btn btn--sm" disabled={busy || keys.length === 0} onClick={() => run(acceptSuggestions)}>
              Add {keys.length} check{keys.length === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy || keys.length === 0}
              title="Don't suggest these again"
              onClick={() => run(dismissSuggestions)}
            >
              Not these
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CheckSuggestions;
