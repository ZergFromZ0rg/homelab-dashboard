import { useState } from "react";

// The command to paste on a new machine, with this dashboard's address
// already in it.
//
// The address comes from window.location.origin — the URL you reached the
// dashboard at. That's the one address we can be certain works from
// somewhere other than the dashboard's own host, which is exactly what the
// new node needs. The backend can't know it: it sees a bind address, not
// however you got here.
const INSTALL_URL =
  "https://raw.githubusercontent.com/ZergFromZ0rg/homelab-agent/main/install.sh";

// node_exporter's default port. The name has to match the node's, which is
// the half of the setup nothing else enforces.
const SCRAPE_EXAMPLE = `scrape_configs:
  - job_name: <node-name>
    static_configs:
      - targets: ['<node-address>:9100']`;

function AddNode() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rebuild, setRebuild] = useState(true);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const command =
    `curl -fsSL ${INSTALL_URL} | sh -s -- \\\n` +
    `  --dashboard ${origin}` +
    (rebuild ? " \\\n  --rebuild" : "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="addnode">
      <button
        type="button"
        className={`addnode-toggle ${open ? "expanded" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="host-toggle">▾</span>
        Add a node
      </button>

      {open && (
        <div className="addnode-body">
          <p className="addnode-note">
            Run this on the new machine. It clones the agent, detects the
            GPU, starts it, and the node registers itself here within a
            minute. Docker is the only prerequisite.
          </p>

          <pre className="addnode-command">{command}</pre>

          <div className="addnode-actions">
            <button type="button" className="btn btn--sm" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>

            <label className="addnode-opt">
              <input
                type="checkbox"
                checked={rebuild}
                onChange={(e) => setRebuild(e.target.checked)}
              />
              Allow rebuilds from here
            </label>
          </div>

          <p className="addnode-note addnode-note--small">
            If this dashboard has <code>API_TOKEN</code> set, add{" "}
            <code>--token</code> with that value.
          </p>

          <p className="addnode-note addnode-note--head">
            Then add it to Prometheus
          </p>
          <p className="addnode-note">
            Host CPU, RAM and disk come from Prometheus, not the agent, and
            the two are joined on the name. The job must be called exactly
            what the node is called, or the host shows containers with every
            gauge blank.
          </p>

          <pre className="addnode-command">{SCRAPE_EXAMPLE}</pre>

          <p className="addnode-note addnode-note--small">
            The node defaults to its own hostname — pass <code>--name</code>{" "}
            above if you want it called something else. Any mismatch is
            flagged on the Overview with the fix.
          </p>
        </div>
      )}
    </section>
  );
}

export default AddNode;
