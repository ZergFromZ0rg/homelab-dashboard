import { useCallback, useEffect, useState } from "react";
import brandImage from "../assets/brand.webp";
import { AUTH_REQUIRED_EVENT } from "./apiAuth";
import "./passkeys.css";
import {
  getAuthStatus,
  passkeyError,
  passkeysSupported,
  signInWithPasskey,
} from "./passkeyApi";

// Shows the dashboard, or the passkey sign-in screen once login is on and
// this browser has no session. Login is off until the first passkey is
// added (Settings → Passkeys), so a fresh install walks straight in.
function AuthGate({ children }) {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(() => {
    getAuthStatus()
      .then(setStatus)
      // Backend unreachable: let the dashboard render its own
      // "disconnected" state rather than a sign-in screen that can't work.
      .catch(() => setStatus({ enabled: false, signed_in: false, rp_ids: [] }));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_REQUIRED_EVENT, refresh);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, refresh);
  }, [refresh]);

  if (!status) return null;
  if (status.enabled && !status.signed_in) {
    return <SignIn rpIds={status.rp_ids} onSignedIn={refresh} />;
  }
  return children;
}

function SignIn({ rpIds, onSignedIn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await signInWithPasskey();
      onSignedIn();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  // Passkeys are bound to the hostname they were made on; on plain http or
  // another name, point at the address that works.
  const here = window.location.hostname;
  const elsewhere = rpIds.filter((id) => id !== here);
  const usable = passkeysSupported && rpIds.includes(here);

  return (
    <div className="signin">
      <div className="signin-card">
        <span className="brand-mark signin-mark" aria-hidden="true">
          <img src={brandImage} alt="" />
        </span>
        <h1>Homelab</h1>
        {usable ? (
          <>
            <button type="button" className="signin-btn" onClick={signIn} disabled={busy} autoFocus>
              {busy ? "Waiting for passkey…" : "Sign in with passkey"}
            </button>
            {error && <p className="signin-error">{error}</p>}
          </>
        ) : (
          <>
            <p className="signin-note">
              {passkeysSupported ? "No passkey for this address." : "Passkeys need HTTPS."}
            </p>
            {elsewhere.map((id) => (
              <a key={id} className="signin-btn" href={`https://${id}${window.location.pathname}`}>
                Open {id}
              </a>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default AuthGate;
