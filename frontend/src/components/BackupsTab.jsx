import { useCallback, useEffect, useState } from "react";
import BackupCard from "./BackupCard";
import BackupForm from "./BackupForm";
import { createBackup, deleteBackup, fetchBackups, updateBackup } from "./backupsApi";
import { formatAge, formatBytes } from "./format";
import { useNow } from "./useNow";

// Scheduled volume backups.
//
// Polled rather than pushed down /ws: the job list changes when somebody
// edits it or a backup finishes, which is minutes or hours apart, and the
// /ws payload is already the hot path for every 2-second tick.

const POLL_MS = 15000;
const ORDER = { failing: 0, stale: 1, pending: 2, running: 3, ok: 4, paused: 5 };

function Fact({ label, value, sub, bad }) {
  return (
    <div className={`fact ${bad ? "fact--bad" : ""}`}>
      <span className="fact-label">{label}</span>
      <strong className="fact-value">{value}</strong>
      {sub && <span className="fact-sub">{sub}</span>}
    </div>
  );
}

// Worst first. The state itself is the backend's call — see
// volume_backups.state — so this only decides the order.
function rank(job) {
  return ORDER[job.state] ?? ORDER.ok;
}

function BackupsTab({ machines, connected }) {
  const now = useNow(30000).getTime() / 1000;
  const [data, setData] = useState({ backups: [], default_dest_host: null });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    () =>
      fetchBackups()
        .then((body) => {
          setData(body);
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoaded(true)),
    []
  );

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const hosts = Object.keys(machines).sort();
  const jobs = [...(data.backups || [])].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)
  );

  const failing = jobs.filter((j) => rank(j) <= ORDER.stale).length;
  const protectedBytes = jobs.reduce((sum, j) => sum + (j.last_archive?.bytes || 0), 0);
  const unprotected = jobs.filter((j) => j.dest_host === j.source_host).length;
  // "Needs attention" used to be its own tile, repeating the Jobs tile's
  // sub-line. How old the worst job's newest archive is says more: it's how
  // much you'd lose if that one mattered today.
  const ages = jobs
    .filter((j) => j.last_success_at)
    .map((j) => now - j.last_success_at);
  const stalest = ages.length ? Math.max(...ages) : null;

  return (
    <section className="backups-tab">
      {jobs.length > 0 && (
        <div className="facts-row">
          <Fact
            label="Jobs"
            value={jobs.length}
            sub={failing ? `${failing} need attention` : "all current"}
            bad={failing > 0}
          />
          <Fact
            label="Furthest behind"
            value={stalest == null ? "—" : formatAge(stalest)}
            sub="age of its newest archive"
          />
          <Fact
            label="Newest archives"
            value={formatBytes(protectedBytes)}
            sub="one per job"
          />
          <Fact
            label="Same-host copies"
            value={unprotected}
            sub={unprotected ? "dies with the machine" : "all off-host"}
            bad={unprotected > 0}
          />
        </div>
      )}

      <div className="services-head">
        <div>
          <h2>Volume backups</h2>
          <p className="settings-hint">
            A throwaway container tars the volume on its own host and writes
            the archive where you point it — by default onto the box running
            this dashboard. Config backups are separate, and already run on
            every agent.
          </p>
        </div>
        {!adding && hosts.length > 0 && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            + Add backup
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      {adding && (
        <div className="backup backup--editing">
          <BackupForm
            hosts={hosts}
            defaultDestHost={data.default_dest_host}
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              await createBackup(values);
              setAdding(false);
              await load();
            }}
          />
        </div>
      )}

      {!jobs.length && !adding ? (
        <div className="empty-state">
          {!loaded && connected === false
            ? "Connecting…"
            : "Nothing is backed up yet. A volume holds the data a container "
              + "can't be rebuilt from — a database, a library, a config store."}
        </div>
      ) : (
        <div className="backups-table">
          <div className="backup-head-row" role="presentation">
            <span>Job</span>
            <span>From → to</span>
            <span>Newest copy</span>
            <span>Schedule</span>
            <span>Verified</span>
            <span>Keep</span>
            <span>Status</span>
            <span />
          </div>
          {jobs.map((job) => (
            <BackupCard
              key={job.id}
              job={job}
              hosts={hosts}
              defaultDestHost={data.default_dest_host}
              now={now}
              onChanged={async (patch) => {
                if (patch) await updateBackup(job.id, patch);
                await load();
              }}
              onDelete={async () => {
                await deleteBackup(job.id);
                await load();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default BackupsTab;
