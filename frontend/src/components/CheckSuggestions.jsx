import { useState } from "react";
import { acceptSuggestions, dismissSuggestions } from "./checksApi";
import { TYPE_LABEL } from "./checkStatus";

// "Nothing watches this yet": hosts and containers the dashboard already knows
// about, one tick away from being a check. Everything starts ticked — leaving out
// the two you don't want is less work than ticking the nine you do. `items` is the
// list, `onDone` is called after Add or "Not these" so the caller can fetch the
// shorter list.
function CheckSuggestions({ items, onDone }) {
  const [picked, setPicked] = useState(null); // null = all
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chosen = picked ?? new Set(items.map((i) => i.key));
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
      onDone(keys.length === items.length);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return <p className="overview-empty">Everything the dashboard knows about is being checked.</p>;

  const groups = [...new Set(items.map((i) => i.group))];

  return (
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
                {i.origin && <span className="chip" title={`Runs from ${i.origin}'s agent`}>from {i.origin}</span>}
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
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy || keys.length === 0} title="Don't suggest these again" onClick={() => run(dismissSuggestions)}>
          Not these
        </button>
      </div>
    </div>
  );
}

export default CheckSuggestions;
