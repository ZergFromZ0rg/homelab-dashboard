import { useEffect, useState } from "react";
import BackupForm from "./BackupForm";
import { deleteArchives, fetchBackupArchives, runBackup, verifyArchive } from "./backupsApi";
import { formatAge, formatBytes } from "./format";
import { hostColor } from "./hostColor";

// One backup job: what it copies, where to, when it last worked, and what
// it has actually written.
//
// The state shown is deliberately about the *last success*, not the last
// attempt. "Ran 5 minutes ago" is worthless if that run failed; what you
// need off a glance is how old the newest archive you could restore from
// is.

function interval(hours) {
  if (hours % 168 === 0) return `every ${hours / 168 === 1 ? "week" : `${hours / 168} weeks`}`;
  if (hours % 24 === 0) return `every ${hours / 24 === 1 ? "day" : `${hours / 24} days`}`;
  return `every ${hours} h`;
}

// The backend decides how a job is doing and says so in `state`; this is
// only the word for it. Deciding it here as well is how the tab and the
// alert that pages you end up disagreeing.
const STATE_LABELS = {
  running: "Running",
  paused: "Paused",
  failing: "Last run failed",
  pending: "Not run yet",
  stale: "Behind schedule",
  corrupt: "Archive unreadable",
  ok: "Up to date",
};

// The result of reading an archive back. Deliberately terse: the useful
// states are "intact, N files" and the reason it isn't.
function verdict(result) {
  if (!result) return null;
  if (result.pending) return <span className="muted">reading…</span>;
  if (result.ok) {
    return (
      <span className="archive-ok" title={`${result.bytes} bytes uncompressed`}>
        intact · {result.files} files
      </span>
    );
  }
  return <span className="archive-bad" title={result.error}>failed</span>;
}


function Archives({ job, now, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [checked, setChecked] = useState({});

  // Fetched when the panel opens rather than with the job list: it costs a
  // round trip to the destination agent, and most of the time nobody is
  // looking at it.
  useEffect(() => {
    let live = true;

    fetchBackupArchives(job.id)
      .then((body) => live && setData(body))
      .catch((e) => live && setError(e.message));

    return () => {
      live = false;
    };
  }, [job.id, reload]);

  const check = async (name) => {
    setChecked((was) => ({ ...was, [name]: { pending: true } }));
    try {
      const result = await verifyArchive(job.id, name);
      setChecked((was) => ({ ...was, [name]: result }));
    } catch (e) {
      setChecked((was) => ({ ...was, [name]: { ok: false, error: e.message } }));
    }
  };

  const remove = async (name) => {
    setBusy(true);
    try {
      await deleteArchives(job.id, [name]);
      setData(null);
      setError(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup-archives">
      <div className="backup-archives-head">
        <strong>Archives</strong>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p className="settings-hint">Reading {job.dest_host}…</p>}

      {data && (
        <>
          <ul className="backup-archive-list">
            {data.archives.map((archive) => (
              <li key={archive.name}>
                <code>{archive.name}</code>
                <span>{formatBytes(archive.bytes)}</span>
                <span>{formatAge(now - archive.modified_at)}</span>
                <span className="archive-check">{verdict(checked[archive.name])}</span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={checked[archive.name]?.pending}
                  onClick={() => check(archive.name)}
                >
                  {checked[archive.name]?.pending ? "Reading…" : "Verify"}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete ${archive.name}? This is a backup.`)) {
                      remove(archive.name);
                    }
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
            {!data.archives.length && <li className="muted">Nothing written yet.</li>}
          </ul>

          {/* Restoring is a deliberate, hands-on job and the dashboard
              does not do it for you. What it can do is spell out the
              steps with this job's real hosts, paths and containers in
              them — a restore happens rarely, under pressure, and usually
              by someone reading it for the first time. */}
          <details className="backup-restore">
            <summary>How to restore this backup</summary>
            <ol className="restore-steps">
              {(data.restore || []).map((step, i) => (
                <li key={i}>
                  <span className="restore-where">on {step.where}</span>
                  <p>{step.what}</p>
                  <pre>{step.command}</pre>
                </li>
              ))}
            </ol>
            <p className="settings-hint">
              Replace the archive name if you want an older one. Nothing here
              runs from the dashboard — restoring overwrites live data, so it
              is deliberately a thing you do yourself.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

function BackupCard({ job, hosts, defaultDestHost, now, onChanged, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [showArchives, setShowArchives] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const status = job.state || "pending";
  const archive = job.last_archive;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await runBackup(job.id);
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="backup backup--editing">
        <BackupForm
          hosts={hosts}
          defaultDestHost={defaultDestHost}
          job={job}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await onChanged(values);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`backup backup--${status}`}>
      <div className="backup-head">
        <div>
          <h3>{job.name}</h3>
          <p className="backup-route">
            <code>{job.volume || job.path}</code> on{" "}
            <span
              className="chip chip--host"
              style={{ color: hostColor(job.source_host), borderColor: hostColor(job.source_host) }}
            >
              {job.source_host}
            </span>{" "}
            →{" "}
            <span
              className="chip chip--host"
              style={{ color: hostColor(job.dest_host), borderColor: hostColor(job.dest_host) }}
            >
              {job.dest_host}
            </span>
            <code>{job.directory}</code>
          </p>
        </div>
        <span className={`backup-state backup-state--${status}`}>
          {STATE_LABELS[status] || status}
        </span>
      </div>

      <div className="backup-facts">
        <div>
          <span className="fact-label">Newest archive</span>
          <strong>{job.last_success_at ? formatAge(now - job.last_success_at) : "—"}</strong>
          {archive?.bytes != null && <em>{formatBytes(archive.bytes)}</em>}
        </div>
        <div>
          <span className="fact-label">Schedule</span>
          <strong>{interval(job.interval_hours)}</strong>
          {job.enabled === false && <em>paused</em>}
        </div>
        <div>
          <span className="fact-label">Verified</span>
          <strong>
            {job.last_verify_ok === true
              ? formatAge(now - job.last_verify_at)
              : job.last_verify_ok === false
                ? "failed"
                : job.last_verify_at
                  ? "couldn't check"
                  : "—"}
          </strong>
          {job.last_verified?.files != null && job.last_verify_ok && (
            <em>{job.last_verified.files} files read back</em>
          )}
          {!job.verify_interval_hours && <em>checking off</em>}
        </div>
        <div>
          <span className="fact-label">Keeping</span>
          <strong>{job.keep}</strong>
          {job.last_pruned?.length > 0 && <em>pruned {job.last_pruned.length} last run</em>}
        </div>
        {job.stop_containers && (
          <div>
            <span className="fact-label">While copying</span>
            <strong>containers stopped</strong>
          </div>
        )}
      </div>

      {job.last_error && (
        <p className="backup-error" title={job.last_error}>
          {job.last_error}
        </p>
      )}
      {job.last_verify_ok === false && (
        <p className="backup-error" title={job.last_verify_error || undefined}>
          Newest archive did not read back — this backup cannot be restored
          from. {job.last_verify_error}
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="backup-actions">
        <button type="button" className="btn btn--sm" disabled={busy || job.running} onClick={run}>
          {job.running ? "Running…" : "Back up now"}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setShowArchives((v) => !v)}>
          {showArchives ? "Hide archives" : "Archives"}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onChanged({ enabled: !job.enabled })}
        >
          {job.enabled ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            if (
              window.confirm(
                `Stop backing up "${job.name}"? Archives already written are kept.`
              )
            ) {
              onDelete();
            }
          }}
        >
          Remove
        </button>
      </div>

      {showArchives && (
        <Archives job={job} now={now} onClose={() => setShowArchives(false)} />
      )}
    </div>
  );
}

export default BackupCard;
