import { useEffect, useRef, useState } from "react";
import { getSelfUpdateStatus, triggerSelfUpdate } from "./selfUpdateApi";

const POLL_MS = 3000;
// ~10 minutes — a cold image rebuild can take a while on a slow box.
const MAX_POLLS = 200;

// Sits next to the connection pill. Backend-gated (HOST_REPO_PATH +
// Docker socket via the compose.self-update.yml overlay — see
// .env.example); hidden entirely rather than shown-and-broken when
// that's not set up, so most installs never see it.
function SelfUpdateButton() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pollTimer = useRef(null);

  useEffect(() => {
    getSelfUpdateStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false, state: "unavailable" }));
    return () => clearTimeout(pollTimer.current);
  }, []);

  const pollUntilDone = (attempt = 0) => {
    if (attempt >= MAX_POLLS) return;
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await getSelfUpdateStatus();
        setStatus(next);
        if (next.state === "running") pollUntilDone(attempt + 1);
      } catch {
        // dashboard-api is mid-restart — expected, keep trying.
        pollUntilDone(attempt + 1);
      }
    }, POLL_MS);
  };

  const trigger = async () => {
    if (
      !window.confirm(
        "Pull the latest code and rebuild/restart the dashboard now? " +
          "You'll be briefly disconnected while it restarts."
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await triggerSelfUpdate();
      setStatus((s) => ({ ...s, state: "running" }));
      pollUntilDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!status || !status.available) return null;

  const running = status.state === "running";

  return (
    <div className="self-update">
      {status.state === "succeeded" && (
        <span className="self-update-result self-update-result--ok">
          ✓ updated
        </span>
      )}
      {status.state === "failed" && (
        <span
          className="self-update-result self-update-result--bad"
          title={status.log || "check dashboard-api's own logs"}
        >
          ✗ update failed
        </span>
      )}
      {error && (
        <span className="self-update-result self-update-result--bad">
          {error}
        </span>
      )}
      <button
        type="button"
        className="self-update-btn"
        disabled={busy || running}
        onClick={trigger}
        title="Pull the latest code from git and rebuild/restart the dashboard"
      >
        {running ? "Updating…" : "⟳ Update"}
      </button>
    </div>
  );
}

export default SelfUpdateButton;
