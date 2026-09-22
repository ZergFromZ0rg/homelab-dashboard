import { useCallback, useEffect, useState } from "react";
import BackupCard from "./BackupCard";
import BackupForm from "./BackupForm";
import { createBackup, deleteBackup, fetchBackups, updateBackup } from "./backupsApi";
import { formatBytes } from "./format";
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

function rank(job, now) {
  if (job.running) return ORDER.running;
  if (!job.enabled) return ORDER.paused;
  if (job.last_error && (job.last_run_at || 0) > (job.last_success_at || 0)) {
    return ORDER.failing;
  }
  if (!job.last_success_at) return ORDER.pending;
  if (now - job.last_success_at > job.interval_hours * 3600 * 1.5) return ORDER.stale;
  return ORDER.ok;
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
    (a, b) => rank(a, now) - rank(b, now) || a.name.localeCompare(b.name)
  );

  const failing = jobs.filter((j) => rank(j, now) <= ORDER.stale).length;
  const protectedBytes = jobs.reduce((sum, j) => sum + (j.last_archive?.bytes || 0), 0);
  const unprotected = jobs.filter((j) => j.dest_host === j.source_host).length;

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
          <Fact label="Needs attention" value={failing} bad={failing > 0} />
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
        <div className="backups-list">
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
