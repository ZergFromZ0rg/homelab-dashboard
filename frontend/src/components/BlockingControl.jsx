import { useState } from "react";
import { formatCountdown, pauseRemaining, setBlocking } from "./piholeApi";

// Pause ad blocking network-wide for a while, or put it back. A pause with a
// timer puts itself back; "until resumed" does not, so it says so.

const CHOICES = [
  [5, "5 min"],
  [30, "30 min"],
  [60, "1 hour"],
  [null, "until resumed"],
];

function BlockingControl({ snapshot, now, onChange }) {
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paused = snapshot.blocking && !snapshot.blocking.enabled;
  const left = pauseRemaining(snapshot, now.getTime() / 1000);

  const act = async (enabled, minutes) => {
    setBusy(true);
    setError("");
    setMenu(false);
    try {
      onChange(await setBlocking(enabled, minutes));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="pihole-block">
      {paused ? (
        <>
          <span className="pihole-paused">
            Blocking paused{snapshot.blocking.timer != null ? ` · ${formatCountdown(left)} left` : " until resumed"}
          </span>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(true)}>
            Resume
          </button>
        </>
      ) : menu ? (
        <>
          <span className="net-dim">Pause for</span>
          {CHOICES.map(([minutes, label]) => (
            <button key={label} type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act(false, minutes)}>
              {label}
            </button>
          ))}
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Cancel" onClick={() => setMenu(false)}>
            ×
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setMenu(true)} title="Stop blocking ads for every device, for a while">
          Pause blocking
        </button>
      )}
      {error && <span className="dev-error">{error}</span>}
    </span>
  );
}

export default BlockingControl;
