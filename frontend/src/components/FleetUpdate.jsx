import { useState } from "react";
import { rebuildFleet } from "./rebuildApi";

// How many agents are current, and one button to fix the ones that aren't.
//
// The button only appears when something is actually out of date — a
// control that does nothing most of the time trains you to ignore it.
function FleetUpdate({ machines }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const names = Object.keys(machines);
  const states = names.map((n) => machines[n].agent_version?.state);
  const known = states.filter((s) => s && s !== "unknown");
  const current = states.filter((s) => s === "current").length;
  const stale = names.filter(
    (n) => ["rebuild", "behind"].includes(machines[n].agent_version?.state)
  );
  // Agents whose remote couldn't be reached. Not stale as far as we know,
  // but not confirmed current either — counting them as current would
  // hide a host sitting behind.
  const unverified = names.filter(
    (n) => machines[n].agent_version?.state === "unverified"
  );

  async function run() {
    const ok = window.confirm(
      `Update ${stale.length} agent${stale.length === 1 ? "" : "s"}?\n\n` +
        stale.join(", ") +
        `\n\nEach pulls its own checkout and rebuilds. Agents go down for ` +
        `about a minute while they're replaced.`
    );
    if (!ok) return;

    setBusy(true);
    setError(null);

    try {
      setResult(await rebuildFleet(stale));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const value = known.length ? `${current}/${known.length}` : "—";
  let note = null;
  if (error) note = <span className="stat-note stat-note--bad" title={error}>failed</span>;
  else if (result) note = <span className="stat-note">{result.started} updating{result.failed ? `, ${result.failed} failed` : ""}</span>;
  else if (stale.length) {
    note = (
      <button type="button" className="stat-action" disabled={busy} aria-busy={busy || undefined} onClick={run} title={`Behind: ${stale.join(", ")}`}>
        {busy ? "starting…" : `update ${stale.length}`}
      </button>
    );
  } else if (unverified.length) {
    note = <span className="stat-note" title={`${unverified.join(", ")}: the remote couldn't be checked`}>{unverified.length} unchecked</span>;
  }

  return (
    <span className={`stat-item ${stale.length ? "stat-item--warn" : ""}`} title="Agents on the latest commit">
      <span className="stat-label">Agents</span>
      <strong>{value}</strong>
      {note}
    </span>
  );
}

export default FleetUpdate;
