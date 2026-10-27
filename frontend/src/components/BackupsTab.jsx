import "./backups.css";
import PageLede from "./PageLede";
import Panel from "./Panel";
import { purposeOf } from "./navPurpose";
import { useCallback, useEffect, useState } from "react";
import BackupCard from "./BackupCard";
import BackupForm from "./BackupForm";
import HostProtection from "./HostProtection";
import { createBackup, deleteBackup, fetchBackups, updateBackup } from "./backupsApi";
import { formatAge, formatBytes } from "./format";
import { protection } from "./recovery";
import { useNow } from "./useNow";
import { useFitHeight } from "./useFitHeight";
import { useRecoveries } from "./useRecoveries";

// Scheduled volume backups, and what each host would lose if it died.
//
// The job list is polled rather than pushed down /ws: it changes when somebody
// edits it or a backup finishes, which is minutes or hours apart, and the /ws
// payload is already the hot path for every 2-second tick.

const POLL_MS = 15000;
const RUNNING_POLL_MS = 3000;
const ORDER = { failing: 0, stale: 1, pending: 2, running: 3, ok: 4, paused: 5 };

function Fact({ label, value, sub, bad, title }) {
  return (
    <div className={`fact ${bad ? "fact--bad" : ""}`} title={title}>
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

function BackupsTab({ machines, connected, showLocation = false, onOpenFolder, onNavigate }) {
  const fit = useFitHeight();
  const now = useNow(30000).getTime() / 1000;
  const [data, setData] = useState({ backups: [], default_dest_host: null });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const running = (data.backups || []).some((b) => b.running);

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
    // Fast while a copy is under way, so its bar moves.
    const timer = setInterval(load, running ? RUNNING_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [load, running]);

  const hosts = Object.keys(machines).sort();
  const recoveries = useRecoveries(hosts);
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

  // What the hosts would lose, added up once their agents have answered.
  const verdicts = hosts.map((h) =>
    protection({ backup: machines[h]?.backup, recovery: recoveries[h]?.data ?? null, failed: Boolean(recoveries[h]?.error) })
  );
  const answered = verdicts.filter((p) => p.known);
  const atRiskBytes = answered.reduce((sum, p) => sum + p.bytes, 0);
  const pending = verdicts.some((p) => !p.known && !p.failed);
  const silent = verdicts.filter((p) => p.failed).length;

  return (
    <section className="backups-tab fit-page" ref={fit}>
      <PageLede text={purposeOf("backups")} />
      {(jobs.length > 0 || hosts.length > 0) && (
        <div className="facts-row">
          {jobs.length > 0 && (
            <>
              <Fact
                label="Jobs"
                value={failing ? `${failing} of ${jobs.length} behind` : jobs.length}
                bad={failing > 0}
              />
              <Fact
                label="Furthest behind"
                value={stalest == null ? "—" : formatAge(stalest)}
              />
              <Fact
                label="Newest archives"
                value={formatBytes(protectedBytes)}
              />
              <Fact
                label="Same-host copies"
                value={unprotected}
                bad={unprotected > 0}
              />
            </>
          )}
          {hosts.length > 0 && (
            <Fact
              label="At risk"
              value={answered.length === 0 ? (pending ? "…" : "—") : atRiskBytes > 0 ? formatBytes(atRiskBytes) : "nothing"}
              sub={pending && answered.length > 0 ? "checking…" : silent ? `${silent} host${silent === 1 ? "" : "s"} didn't answer` : undefined}
              bad={atRiskBytes > 0}
              title="Data on your servers that no backup job covers"
            />
          )}
        </div>
      )}

      <div className="bk-board fit-pane">
        <Panel
          title="Volume backups"
          hint="A throwaway container tars the volume on its own host and writes the archive where you point it — by default onto the box running this dashboard. Config backups are separate, and already run on every agent."
          count={jobs.length || null}
          tone={failing ? "bad" : undefined}
          className="bk-jobs"
          actions={
            !adding && hosts.length > 0 ? (
              <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
                + Add backup
              </button>
            ) : null
          }
        >
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
                  showLocation={showLocation}
                  onOpenFolder={onOpenFolder}
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
        </Panel>

        <HostProtection
          hosts={hosts}
          machines={machines}
          recoveries={recoveries}
          onRecover={(host) => onNavigate?.("hosts", { host, page: "manage" })}
          className="bk-protect"
        />
      </div>
    </section>
  );
}

export default BackupsTab;
