import { fetchPihole, piholeState } from "./piholeApi";
import { usePolled } from "./usePolled";
import { useNow } from "./useNow";
import { formatAge, formatDuration } from "./format";
import Stat from "./Stat";
import DeviceTable from "./DeviceTable";

// Pi-hole, network-wide: four numbers and a health card. Everything comes
// from the dashboard's cache; when Pi-hole can't be reached the last good
// numbers stay, marked, so a collector problem doesn't read as an outage.

const POLL_MS = 15000;
const STATES = {
  up: ["ok", "Up"],
  stale: ["warn", "Stale"],
  unreachable: ["bad", "Unreachable"],
  down: ["bad", "Unreachable"],
};

function Health({ snapshot, now }) {
  const { health = {}, blocking, updated_at: updatedAt } = snapshot;
  const versions = Object.entries(health.versions || {}).filter(([, v]) => v);
  const outdated = health.update_available || [];
  return (
    <div className="pihole-health">
      <div className="pihole-health-row">
        <span>Blocking</span>
        <strong>{blocking?.enabled ? "On" : blocking?.state || "—"}</strong>
      </div>
      <div className="pihole-health-row">
        <span>Uptime</span>
        <strong>{health.uptime != null ? formatDuration(health.uptime) : "—"}</strong>
      </div>
      <div className="pihole-health-row">
        <span>Last update</span>
        <strong>{updatedAt ? formatAge(now.getTime() / 1000 - updatedAt) : "—"}</strong>
      </div>
      <div className="pihole-health-row">
        <span>Versions</span>
        <strong className="net-mono" title={versions.map(([k, v]) => `${k} ${v}`).join(" · ")}>
          {versions.map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}
        </strong>
      </div>
      {outdated.length > 0 && (
        <div className="pihole-health-row pihole-health-row--warn">
          <span>Update</span>
          <strong>{outdated.join(", ")} can be updated</strong>
        </div>
      )}
    </div>
  );
}

function PiholePanel() {
  const { data: snapshot, error, loading } = usePolled(fetchPihole, "pihole", POLL_MS);
  const now = useNow(15000);

  if (loading) return <p className="lan-empty">Loading…</p>;
  if (!snapshot) return <p className="lan-empty">Couldn't ask the dashboard about Pi-hole: {error}</p>;

  const state = piholeState(snapshot);
  if (state === "unconfigured") {
    return (
      <p className="lan-empty">
        Pi-hole isn't connected. Create an app password in Pi-hole (Settings → Web interface / API) and set
        <code> PIHOLE_URL </code> and <code> PIHOLE_APP_PASSWORD </code> in the dashboard's <code>.env</code>.
      </p>
    );
  }

  const [tone, label] = STATES[state] || STATES.down;
  const { summary } = snapshot;

  return (
    <div className="pihole">
      <div className="pihole-head">
        <span className={`status-dot status-dot--${tone}`} />
        <strong>Pi-hole</strong>
        <span className={`pihole-state pihole-state--${tone}`}>{label}</span>
        {snapshot.error && <span className="pihole-error" title={snapshot.error}>{snapshot.error}</span>}
        {state !== "up" && summary && <span className="net-dim">Showing the last numbers it returned.</span>}
      </div>

      {summary ? (
        <div className="pihole-tiles">
          <Stat label="Queries today" value={summary.total.toLocaleString()} />
          <Stat label="Blocked" value={`${summary.percent_blocked}%`}>
            <small>{summary.blocked.toLocaleString()} queries</small>
          </Stat>
          <Stat label="Active devices" value={summary.active_clients} />
          <Stat label="On blocklists" value={summary.gravity_domains.toLocaleString()}>
            <small>domains</small>
          </Stat>
        </div>
      ) : (
        <p className="lan-empty">No numbers yet — waiting for the first successful poll.</p>
      )}

      {summary && <Health snapshot={snapshot} now={now} />}
      {summary && <DeviceTable />}
    </div>
  );
}

export default PiholePanel;
