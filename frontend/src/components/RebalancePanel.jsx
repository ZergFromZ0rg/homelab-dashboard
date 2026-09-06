// Polls /api/rebalance for managed containers that would be better off on
// a different node. Suggestions only — "Move" runs the normal redeploy.

import { useEffect, useRef, useState } from "react";
import { fetchRebalance, redeploy } from "./deployApi";

const POLL_MS = 30000;

function RebalancePanel({ deployments }) {
  const [suggestions, setSuggestions] = useState([]);
  // Only surfaced for a failed Move — a failing poll is silent (the
  // suggestions are advisory, not load-bearing).
  const [error, setError] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);
  const [auto, setAuto] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const reloadRef = useRef(() => {});

  // Re-check on an interval and whenever a deployment's status/node changes
  // (e.g. a move just landed). The effect owns the only fetch loop; the
  // ref exposes it to the Move handler without another effect.
  const statusKey = (deployments ?? [])
    .map((d) => `${d.id}:${d.status}:${d.placed_on}`)
    .join("|");

  useEffect(() => {
    let active = true;

    async function reload() {
      try {
        const data = await fetchRebalance();
        if (!active) return;
        setSuggestions(data.suggestions ?? []);
        setCheckedAt(data.checked_at ?? null);
        setAuto(Boolean(data.auto));
      } catch {
        if (active) setSuggestions([]);
      }
    }

    reloadRef.current = reload;
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [statusKey]);

  async function move(suggestion) {
    setBusyId(suggestion.deployment_id);
    setError(null);
    try {
      await redeploy(suggestion.deployment_id, { node: suggestion.to_node });
      await reloadRef.current();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!error && suggestions.length === 0 && !auto) return null;

  return (
    <section className="rebalance-panel">
      <div className="section-header">
        <p className="eyebrow">Optimize</p>
        <h2>
          Rebalancing ({suggestions.length})
          {auto && <span className="rebalance-auto">auto on</span>}
        </h2>
      </div>

      {auto && (
        <p className="deployment-reason">
          The backend moves qualifying stateless workloads on its own; you
          can still move any of these now.
        </p>
      )}

      {error && <p className="placement-warning">⚠ {error}</p>}

      {suggestions.map((s) => (
        <div key={s.deployment_id} className="rebalance-card">
          <div className="rebalance-move">
            <strong>{s.name || s.image}</strong>
            <span className="rebalance-arrow">
              {s.from_node} → {s.to_node}
            </span>
            <span className="rebalance-gain">+{s.gain}</span>
          </div>
          <p className="deployment-reason">{s.reason}</p>
          <div className="deployment-actions">
            <button
              type="button"
              disabled={busyId === s.deployment_id}
              onClick={() => move(s)}
            >
              {busyId === s.deployment_id ? "Moving…" : `Move to ${s.to_node}`}
            </button>
          </div>
        </div>
      ))}

      {checkedAt && (
        <p className="rebalance-checked">
          checked {new Date(checkedAt * 1000).toLocaleTimeString()}
        </p>
      )}
    </section>
  );
}

export default RebalancePanel;
