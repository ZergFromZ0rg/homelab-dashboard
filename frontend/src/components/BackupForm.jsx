import { useEffect, useState } from "react";
import { fetchBackupTargets } from "./backupsApi";
import { hostColor } from "./hostColor";

// Add or edit one backup job.
//
// The volume list and the destination's writable directories both come
// from the agents rather than being typed, because both are things the
// dashboard can just *know* — and a mistyped volume name is a job that
// fails silently every night until somebody looks.
//
// A destination host that can't store backups keeps the agent's own
// wording. It names the exact compose line to add, which is the whole
// value of the message; rephrasing it here would lose the fix.

const HOUR_UNITS = [
  { label: "hours", hours: 1 },
  { label: "days", hours: 24 },
  { label: "weeks", hours: 168 },
];

function splitInterval(hours) {
  for (const unit of [...HOUR_UNITS].reverse()) {
    if (hours >= unit.hours && hours % unit.hours === 0) {
      return { every: hours / unit.hours, unit: unit.label };
    }
  }
  return { every: hours, unit: "hours" };
}

function HostOption({ name }) {
  return (
    <span
      className="chip chip--host"
      style={{ color: hostColor(name), borderColor: hostColor(name) }}
    >
      {name}
    </span>
  );
}

function BackupForm({ hosts, defaultDestHost, job, onSubmit, onCancel }) {
  const editing = Boolean(job);
  const initialInterval = splitInterval(job?.interval_hours ?? 24);

  // A volume is picked from a list; a directory is typed, because the
  // agent won't enumerate the host filesystem and shouldn't.
  const [kind, setKind] = useState(job?.path ? "path" : "volume");
  const [path, setPath] = useState(job?.path || "");
  const [name, setName] = useState(job?.name || "");
  const [sourceHost, setSourceHost] = useState(job?.source_host || hosts[0] || "");
  const [volume, setVolume] = useState(job?.volume || "");
  const [destHost, setDestHost] = useState(
    job?.dest_host || defaultDestHost || hosts[0] || ""
  );
  // null means "nobody has typed a directory", which is what lets the
  // suggestion below stay live as the destination changes. An edited job
  // starts with the one it already has.
  const [directory, setDirectory] = useState(job?.directory ?? null);
  const [every, setEvery] = useState(initialInterval.every);
  const [unit, setUnit] = useState(initialInterval.unit);
  const [keep, setKeep] = useState(job?.keep ?? 7);
  const [stopContainers, setStopContainers] = useState(Boolean(job?.stop_containers));

  // Each answer is stored with the host it describes rather than being
  // cleared before the next fetch. "Still loading" is then something we
  // can derive, and there is no moment where bigboy's volumes are on
  // screen under thinkpad's name.
  const [source, setSource] = useState(null);
  const [dest, setDest] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sourceHost) return undefined;
    let live = true;

    fetchBackupTargets(sourceHost)
      .then((data) => live && setSource({ host: sourceHost, data }))
      .catch((err) => live && setSource({ host: sourceHost, error: err.message }));

    return () => {
      live = false;
    };
  }, [sourceHost]);

  useEffect(() => {
    if (!destHost) return undefined;
    let live = true;

    fetchBackupTargets(destHost)
      .then((data) => live && setDest({ host: destHost, data }))
      .catch((err) => live && setDest({ host: destHost, error: err.message }));

    return () => {
      live = false;
    };
  }, [destHost]);

  const sourceReady = source?.host === sourceHost;
  const destReady = dest?.host === destHost;
  const loading = !sourceReady;

  const volumes = (sourceReady && source.data?.volumes) || [];
  const sourceDirs = (sourceReady && source.data?.sources?.dirs) || [];
  const chosen = volumes.find((v) => v.name === volume);
  const inUse = chosen?.in_use_by || [];
  const picked = kind === "volume" ? volume : path.trim();
  const destRoots = (destReady && dest.data?.store?.roots) || [];
  const usableRoots = destRoots.filter((r) => r.usable);

  // Offer a directory rather than making them invent one: the first
  // writable root, with the source host's name under it so two hosts
  // backing up to one box don't pile into the same folder. Derived, not
  // stored, so it follows the destination until somebody types over it.
  const suggested = usableRoots.length
    ? `${usableRoots[0].path.replace(/\/$/, "")}/${sourceHost}`
    : "";
  const sourceProblem =
    kind === "path" && sourceReady && !sourceDirs.length
      ? `${sourceHost} backs up named volumes only: set BACKUP_SOURCE_DIRS `
        + "on its agent to allow backing up a directory"
      : null;
  const directoryValue = directory ?? suggested;

  const destProblem = (destReady && !dest.data?.store?.enabled)
    ? `${destHost} stores no backups: set BACKUP_DIRS on its agent and give it a writable volume`
    : destRoots.find((r) => !r.usable)?.problem
      || (sourceReady && source.error) || (destReady && dest.error) || null;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const hours = every * (HOUR_UNITS.find((u) => u.label === unit)?.hours || 1);

    try {
      await onSubmit({
        name: name.trim() || (kind === "volume" ? volume : path.split("/").filter(Boolean).pop()),
        source_host: sourceHost,
        ...(kind === "volume" ? { volume } : { path: path.trim() }),
        dest_host: destHost,
        directory: directoryValue.trim(),
        interval_hours: hours,
        keep: Number(keep),
        stop_containers: stopContainers,
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="backup-form" onSubmit={submit}>
      <div className="backup-form-grid">
        <label>
          <span>Back up</span>
          <div className="segmented segmented--inline">
            <button
              type="button"
              className={kind === "volume" ? "active" : ""}
              onClick={() => setKind("volume")}
            >
              Volume
            </button>
            <button
              type="button"
              className={kind === "path" ? "active" : ""}
              onClick={() => setKind("path")}
            >
              Directory
            </button>
          </div>

          {kind === "volume" ? (
            <>
              <select
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                required
                disabled={loading || !volumes.length}
              >
                <option value="">
                  {loading ? "Reading volumes…" : "Pick a volume"}
                </option>
                {volumes.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                    {v.project ? ` · ${v.project}` : ""}
                  </option>
                ))}
              </select>
              {!loading && !volumes.length && (
                <em className="field-hint">
                  {sourceHost} reported no named volumes. Plenty of stacks keep
                  their data in a bind mount instead — try Directory.
                </em>
              )}
            </>
          ) : (
            <>
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/zerg/ai-librarian/data/qdrant"
                required
              />
              {sourceDirs.length > 0 && (
                <em className="field-hint">
                  Under {sourceDirs.join(", ")} on <HostOption name={sourceHost} />
                </em>
              )}
            </>
          )}
        </label>

        <label>
          <span>On</span>
          <select value={sourceHost} onChange={(e) => setSourceHost(e.target.value)}>
            {hosts.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>

        <label>
          <span>To</span>
          <select value={destHost} onChange={(e) => setDestHost(e.target.value)}>
            {hosts.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          {destHost === sourceHost && (
            <em className="field-hint field-hint--warn">
              Same host — a backup that dies with the machine it's on.
            </em>
          )}
        </label>

        <label className="backup-form-wide">
          <span>Directory</span>
          <input
            value={directoryValue}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/backups/bigboy"
            required
          />
          {usableRoots.length > 0 && (
            <em className="field-hint">
              Under {usableRoots.map((r) => r.path).join(", ")} on{" "}
              <HostOption name={destHost} />
            </em>
          )}
        </label>

        <label>
          <span>Every</span>
          <div className="field-row">
            <input
              type="number"
              min="1"
              value={every}
              onChange={(e) => setEvery(Number(e.target.value))}
              required
            />
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {HOUR_UNITS.map((u) => (
                <option key={u.label} value={u.label}>{u.label}</option>
              ))}
            </select>
          </div>
        </label>

        <label>
          <span>Keep</span>
          <div className="field-row">
            <input
              type="number"
              min="1"
              max="500"
              value={keep}
              onChange={(e) => setKeep(Number(e.target.value))}
              required
            />
            <em className="field-hint">newest archives</em>
          </div>
        </label>

        <label className="backup-form-wide checkbox">
          <input
            type="checkbox"
            checked={stopContainers}
            onChange={(e) => setStopContainers(e.target.checked)}
          />
          <span>
            Stop its containers while copying
            {kind === "volume" && inUse.length > 0 && (
              <em className="field-hint">
                {inUse.join(", ")} — a database copied while it's writing can
                restore to a torn file.
              </em>
            )}
            {kind === "path" && (
              <em className="field-hint">
                Anything bind-mounting this directory is stopped for the copy.
                A database copied while it's writing can restore to a torn file.
              </em>
            )}
          </span>
        </label>

        <label className="backup-form-wide">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={picked.split("/").filter(Boolean).pop() || "qdrant"}
          />
        </label>
      </div>

      {sourceProblem && <p className="form-error">{sourceProblem}</p>}
      {destProblem && <p className="form-error">{destProblem}</p>}
      {error && <p className="form-error">{error}</p>}

      <div className="form-actions">
        <button
          type="submit"
          className="btn"
          /* A job whose source or destination host isn't set up would be
             accepted here and then fail on every run, so it can't be
             saved — and the message above already names the fix. */
          disabled={
            saving
            || !picked
            || !directoryValue.trim()
            || Boolean(sourceProblem)
            || Boolean(destProblem)
          }
        >
          {saving ? "Saving…" : editing ? "Save" : "Add backup"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default BackupForm;
