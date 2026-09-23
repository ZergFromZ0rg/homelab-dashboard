import { useState } from "react";
import { DEMO, demoHostRecovery } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";
import { backupProjects, fetchBackupDestinations } from "./backupsApi";
import { formatAge, formatBytes } from "./format";

// What you would have if this machine died tonight.
//
// Three separate questions, shown separately because they have three
// separate answers and one "backup: ok" hides that:
//
//   its compose files  — what you rebuild the stacks *from*
//   its data           — only whatever a backup job actually covers
//   everything else    — what you would lose
//
// The third is the point. A host nobody has configured lists every project
// as unprotected, rather than looking clean because there is nothing to
// compare against.

function fetchRecovery(host) {
  if (DEMO) return Promise.resolve(demoHostRecovery(host));
  return fetch(`/api/hosts/${encodeURIComponent(host)}/recovery`, {
    headers: authHeaders(),
  }).then(jsonOrThrow);
}

function ConfigBackup({ status }) {
  const state = status?.state;
  const tone =
    state === "ok" ? "ok" : state === "stale" ? "warn" : state === "unknown" ? "none" : "bad";
  const words = {
    ok: "Compose files are backed up",
    stale: "Compose-file backup is behind",
    failing: "Compose-file backup is failing",
    pending: "Compose-file backup hasn't run yet",
    not_configured: "No compose-file backup — nothing to rebuild the stacks from",
    disabled: "Compose-file backup is switched off",
    unsupported: "This agent is too old to report its compose-file backup",
    unknown: "Couldn't ask about the compose-file backup",
  };

  return (
    <p className={`recovery-config recovery-config--${tone}`}>
      <span className={`status-dot status-dot--${tone === "ok" ? "ok" : tone}`} />
      {words[state] || state}
      {status?.last_success_age != null && state === "ok" && (
        <em> · pushed {formatAge(status.last_success_age)}</em>
      )}
    </p>
  );
}

function HostRecovery({ host }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Which stacks to protect. Everything unprotected is ticked to start
  // with, because that is the answer almost everyone wants and un-ticking
  // the two you don't care about is less work than ticking the six you do.
  const [chosen, setChosen] = useState(null);
  const [dests, setDests] = useState(null);
  const [destHost, setDestHost] = useState("");
  const [result, setResult] = useState(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const body = await fetchRecovery(host);
      setData(body);
      setChosen(
        new Set(body.projects.filter((p) => !p.protected).map((p) => p.project))
      );

      const where = await fetchBackupDestinations().catch(() => ({ destinations: [] }));
      const usable = (where.destinations || []).filter(
        (d) => d.can_store && d.host !== host
      );
      setDests(usable);
      setDestHost((current) => current || usable[0]?.host || "");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    if (!open && data === null && !busy) load();
    setOpen(!open);
  }

  const gaps = data?.unprotected_count ?? 0;

  return (
    <div className="conn-panel">
      <button
        type="button"
        className={`conn-toggle ${open ? "expanded" : ""}`}
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="host-toggle">▾</span>
        IF THIS HOST DIED
        {data && (
          <span className={`conn-count ${gaps ? "conn-count--bad" : ""}`}>
            {gaps ? `${gaps} unprotected` : "all covered"}
          </span>
        )}
      </button>

      {open && (
        <div className="recovery">
          {busy && !data && <p className="settings-hint">Looking at {host}…</p>}
          {error && <p className="form-error">{error}</p>}

          {data && (
            <>
              <ConfigBackup status={data.config_backup} />

              {gaps > 0 && (
                <p className="recovery-summary">
                  <strong>{formatBytes(data.unprotected_bytes)}</strong> of data
                  in {gaps} place{gaps > 1 ? "s" : ""} has no backup job. Losing
                  this machine loses it.
                </p>
              )}

              <ul className="recovery-projects">
                {data.projects.map((project) => (
                  <li key={project.project}>
                    <div className="recovery-project">
                      {project.protected ? (
                        <strong>{project.project}</strong>
                      ) : (
                        <label className="recovery-pick">
                          <input
                            type="checkbox"
                            checked={chosen?.has(project.project) || false}
                            onChange={(e) => {
                              const next = new Set(chosen);
                              if (e.target.checked) next.add(project.project);
                              else next.delete(project.project);
                              setChosen(next);
                            }}
                          />
                          <strong>{project.project}</strong>
                        </label>
                      )}
                      {project.working_dir && <code>{project.working_dir}</code>}
                    </div>

                    {project.items.length === 0 ? (
                      <p className="recovery-none">no data of its own</p>
                    ) : (
                      <ul className="recovery-items">
                        {project.items.map((item) => (
                          <li key={item.kind + item.name}>
                            <span
                              className={`status-dot status-dot--${
                                item.protected_by
                                  ? item.protected_by.state === "ok"
                                    ? "ok"
                                    : "warn"
                                  : "bad"
                              }`}
                            />
                            <code>{item.name}</code>
                            <span className="recovery-size">
                              {formatBytes(item.bytes)}
                              {item.partial ? "+" : ""}
                            </span>
                            <span className="recovery-cover">
                              {item.protected_by ? (
                                <>
                                  {item.protected_by.job} →{" "}
                                  {item.protected_by.dest}
                                  {item.protected_by.state !== "ok" && (
                                    <strong> ({item.protected_by.state})</strong>
                                  )}
                                </>
                              ) : item.allowed === false ? (
                                "not backed up — this host doesn't allow that directory yet"
                              ) : (
                                "not backed up"
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>

              {gaps > 0 && (
                <div className="recovery-protect">
                  <strong>Protect the ticked stacks</strong>
                  {dests && dests.length === 0 ? (
                    <p className="settings-hint">
                      No other host can store backups yet. Set a backup
                      directory on one of them first — a copy on this machine
                      dies with this machine.
                    </p>
                  ) : (
                    <>
                      <label className="recovery-dest">
                        <span>Send to</span>
                        <select
                          value={destHost}
                          onChange={(e) => setDestHost(e.target.value)}
                        >
                          {(dests || []).map((d) => (
                            <option key={d.host} value={d.host}>
                              {d.host}
                              {d.encrypted ? " · encrypted" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={busy || !destHost || !chosen?.size}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          try {
                            const out = await backupProjects({
                              host,
                              projects: [...chosen],
                              dest_host: destHost,
                              directory: `/backups/${host}`,
                            });
                            setResult(out);
                            await load();
                          } catch (e) {
                            setError(e.message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {busy ? "Working…" : `Back up ${chosen?.size || 0} stack${
                          chosen?.size === 1 ? "" : "s"
                        }`}
                      </button>
                    </>
                  )}

                  {result && (
                    <div className="recovery-result">
                      {result.created.length > 0 && (
                        <p>Created {result.created.length} job
                          {result.created.length > 1 ? "s" : ""}.</p>
                      )}
                      {result.already_covered.length > 0 && (
                        <p className="settings-hint">
                          {result.already_covered.length} already covered.
                        </p>
                      )}
                      {result.refused.map((r) => (
                        <p key={r.name} className="form-error">
                          <code>{r.name}</code> — {r.why}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <details className="recovery-steps">
                <summary>Rebuilding this host</summary>
                <ol>
                  <li>
                    Install the agent on the replacement and join it with the
                    same host name — the Servers tab's <strong>Add a node</strong>{" "}
                    gives the command.
                  </li>
                  <li>
                    Clone the compose-file backup
                    {data.config_backup?.repo ? (
                      <> (<code>{data.config_backup.repo}</code>)</>
                    ) : null}{" "}
                    and put each project back where it was.
                  </li>
                  <li>
                    Restore each project's data from its archives — every
                    backup job's Archives panel spells out the exact commands
                    for its own paths and containers.
                  </li>
                  <li>
                    <code>docker compose up -d</code> per project, oldest
                    dependency first.
                  </li>
                </ol>
                {data.source_dirs?.length === 0 && (
                  <p className="settings-hint">
                    This host allows no directories to be backed up yet. Set
                    them in Settings above, then add jobs from the Backups tab.
                  </p>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default HostRecovery;
