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

// HTTPS is the default once there is somewhere to go: a passkey records the
// HTTPS name it was made on (the tailnet's `tailscale serve` address), so a
// page opened over plain http — `http://thinkpad:8081` — moves itself there.
// Over plain http a passkey can't be used at all, so staying would only
// show a sign-in screen that can't work. Only browsers take this path;
// agents and scripts call /api directly and are unaffected. Local dev
// (localhost) is left alone.
function httpsHome(rpIds) {
  const { protocol, hostname } = window.location;
  if (protocol !== "http:" || !rpIds?.length) return null;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;
  const target = rpIds.find((id) => id.endsWith(".ts.net")) || rpIds[0];
  return `https://${target}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

// Shows the dashboard, or the passkey sign-in screen once login is on and
// this browser has no session. Login is off until the first passkey is
// added (Settings → Passkeys), so a fresh install walks straight in.
function AuthGate({ children }) {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(() => {
    getAuthStatus()
      .then((next) => {
        const home = httpsHome(next.rp_ids);
        if (home) {
          window.location.replace(home);
          return;
        }
        setStatus(next);
      })
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
