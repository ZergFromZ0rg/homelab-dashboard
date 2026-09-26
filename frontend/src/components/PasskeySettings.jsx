import { useEffect, useState } from "react";
import { formatAge } from "./format";
import { useNow } from "./useNow";
import { AUTH_REQUIRED_EVENT } from "./apiAuth";
import {
  listPasskeys,
  passkeyError,
  passkeysSupported,
  registerPasskey,
  removePasskey,
  renamePasskey,
  signOut,
} from "./passkeyApi";

// Settings → Passkeys. Adding the first one turns login on; removing the
// last turns it off. Each row renames on click.
function PasskeySettings() {
  const [keys, setKeys] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const now = useNow(60000).getTime() / 1000;

  useEffect(() => {
    listPasskeys()
      .then((body) => setKeys(body.passkeys))
      .catch((err) => setError(err.message));
  }, []);

  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      await registerPasskey();
      setKeys((await listPasskeys()).passkeys);
    });

  const remove = (key) => {
    const last = keys.length === 1;
    const question = last
      ? `Remove "${key.name}"? It's the last passkey, so login turns off and anyone who can reach this page can use it.`
      : `Remove "${key.name}"? That device will be signed out.`;
    if (!window.confirm(question)) return;
    run(async () => {
      setKeys((await removePasskey(key.id)).passkeys);
      // If that was the passkey this browser signed in with, the session is
      // gone too — let the gate re-check.
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
  };

  const rename = (key, name) => {
    setEditing(null);
    if (!name.trim() || name.trim() === key.name) return;
    run(async () => setKeys((await renamePasskey(key.id, name)).passkeys));
  };

  return (
    <div className="passkeys">
      {keys?.length === 0 && (
        <p className="settings-hint">
          Login is off: anyone who can reach this page can use it. Add a passkey
          to turn it on. You sign in with Face ID, Touch ID or your phone.
        </p>
      )}

      {keys?.length > 0 && (
        <ul className="passkey-list">
          {keys.map((key) => (
            <li className="passkey-row" key={key.id}>
              {editing === key.id ? (
                <input
                  className="passkey-name-input"
                  defaultValue={key.name}
                  maxLength={60}
                  autoFocus
                  onBlur={(e) => rename(key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="passkey-name"
                  onClick={() => setEditing(key.id)}
                  title={`Rename · made on ${key.rp_id}`}
                >
                  {key.name}
                </button>
              )}
              {key.synced && (
                <span className="chip" title="Synced passkey (e.g. iCloud Keychain / Google Password Manager): works on your other devices too">
                  synced
                </span>
              )}
              <span className="passkey-used" title="Last sign-in">
                {formatAge(now - key.last_used_at)}
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => remove(key)}
                disabled={busy}
                aria-label={`Remove ${key.name}`}
                title="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="passkey-actions">
        <button
          type="button"
          className="qa-btn"
          onClick={add}
          disabled={busy || keys === null || !passkeysSupported}
          title={
            passkeysSupported
              ? "Create a passkey on this device"
              : "Passkeys need HTTPS. See docs/deployment.md → Login."
          }
        >
          {keys?.length ? "Add passkey" : "Add a passkey"}
        </button>
        {keys?.length > 0 && (
          <button
            type="button"
            className="qa-btn"
            onClick={() => run(async () => {
              await signOut();
              window.location.reload();
            })}
            disabled={busy}
          >
            Sign out
          </button>
        )}
      </div>
      {!passkeysSupported && (
        <p className="settings-hint">Passkeys need HTTPS. This page is plain HTTP.</p>
      )}
      {error && <p className="signin-error">{error}</p>}
    </div>
  );
}

export default PasskeySettings;
