import { useState } from "react";

// API token entry, only needed when the backend sets API_TOKEN. Kept in
// sessionStorage (cleared with the tab) and shared by every token-gated form.
function TokenBox() {
  const [token, setToken] = useState(sessionStorage.getItem("apiToken") ?? "");
  const [visible, setVisible] = useState(false);
  return (
    <div className="deploy-field">
      <span className="deploy-label">API token (only if the backend sets one)</span>
      <div className="deploy-token-row">
        <input
          className="deploy-input"
          type={visible ? "text" : "password"}
          value={token}
          placeholder="X-Register-Token"
          onChange={(e) => {
            setToken(e.target.value);
            if (e.target.value) sessionStorage.setItem("apiToken", e.target.value);
            else sessionStorage.removeItem("apiToken");
          }}
        />
        <button
          type="button"
          className="qa-btn"
          onClick={() => setVisible((v) => !v)}
          title={visible ? "Hide token" : "Show token"}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export default TokenBox;
