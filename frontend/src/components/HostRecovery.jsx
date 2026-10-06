import { useEffect, useState } from "react";
import { DEMO, demoHostRecovery } from "../demoData";
import { jsonOrThrow } from "./apiAuth";
import {
  backupProjects,
  fetchBackupDestinations,
  ignoreNames,
  unignore,
} from "./backupsApi";
import { formatAge, formatBytes } from "./format";
import Icon from "./Icon";

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
  }).then(jsonOrThrow);
}

const CONFIG_WORDS = {
  ok: "Backed up",
  stale: "Backup is behind",
  failing: "Backup is failing",
  pending: "Hasn't run yet",
  not_configured: "Not backed up",
  disabled: "Switched off",
  unsupported: "Agent too old to say",
  unknown: "Couldn't ask",
};

// One stack: a line with its status, and its data under a fold.
function stackState(project) {
  if (project.ignored) return { tone: "none", label: "Skipped on purpose", sort: 3 };
  if (project.items.length === 0) return { tone: "none", label: "No data of its own", sort: 4 };
  if (!project.settled) return { tone: "bad", label: "Not backed up", sort: 0 };
  const behind = project.items.some((i) => i.protected_by && i.protected_by.state !== "ok");
  return behind ? { tone: "warn", label: "Backup behind", sort: 1 } : { tone: "ok", label: "Backed up", sort: 2 };
}

// `open` / `onToggle` let a parent keep several of these to one open at a time;
// without them it manages itself.
function HostRecovery({ host, defaultOpen = false, open: openProp, onToggle }) {
  const [openState, setOpen] = useState(defaultOpen);
  const open = openProp ?? openState;
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
      // Ticked: gaps nobody has decided about. A stack you already said
      // you don't want must not be pre-selected for backing up.
      setChosen(
        new Set(
          body.projects
            .filter((p) => !p.settled && !p.ignored)
            .map((p) => p.project)
        )
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
    if (onToggle) onToggle();
    else setOpen(!open);
  }

  // Opened from the start (System tab): fetch once on mount.
  useEffect(() => {
    if (!defaultOpen) return undefined;
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const gaps = data?.unprotected_count ?? 0;
  const configState = data?.config_backup?.state;
  const configOk = configState === "ok";
  const atRisk = gaps > 0 || (data && !configOk && configState !== "disabled");

  const skip = async (names, label, fallback, after) => {
    const why = window.prompt(`Why is ${label} not worth backing up?`, fallback);
    if (why === null) return;
    await ignoreNames(host, names, why);
    await load();
    after?.();
  };

  const stacks = data
    ? [...data.projects].map((p) => ({ p, st: stackState(p) })).sort((a, b) => a.st.sort - b.st.sort || a.p.project.localeCompare(b.p.project))
    : [];

  const protect = async () => {
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
  };

  return (
    <div className="conn-panel">
      <button
        type="button"
        className={`conn-toggle ${open ? "expanded" : ""}`}
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="host-toggle" aria-hidden="true"><Icon name="chevron" size={12} /></span>
        RECOVER
        {data && (
          <span className={`conn-count ${atRisk ? "conn-count--bad" : ""}`}>
            {gaps ? `${formatBytes(data.unprotected_bytes)} at risk` : atRisk ? "at risk" : "safe"}
          </span>
        )}
      </button>

      {open && (
        <div className="recovery">
          {busy && !data && <p className="settings-hint">Looking at {host}…</p>}
          {error && <p className="form-error">{error}</p>}

          {data && (
            <>
              <div className={`rec-verdict rec-verdict--${atRisk ? "bad" : "ok"}`}>
                <span className={`status-dot status-dot--${atRisk ? "bad" : "ok"}`} />
                <strong>
                  {atRisk
                    ? `If ${host} died, you would lose${gaps ? ` ${formatBytes(data.unprotected_bytes)} of data` : " your way to rebuild it"}.`
                    : `If ${host} died, everything is backed up.`}
                </strong>
              </div>

              <div className="rec-checks">
                <div className={`rec-check rec-check--${configOk ? "ok" : "bad"}`}>
                  <span>Compose files</span>
                  <strong>{CONFIG_WORDS[configState] || configState}</strong>
                  {configOk && data.config_backup?.last_success_age != null && (
                    <em>pushed {formatAge(data.config_backup.last_success_age)} ago</em>
                  )}
                </div>
                <div className={`rec-check rec-check--${gaps ? "bad" : "ok"}`}>
                  <span>Data</span>
                  <strong>{gaps ? `${gaps} stack${gaps > 1 ? "s" : ""} not backed up` : "All backed up"}</strong>
                  {data.ignored_count > 0 && <em>{data.ignored_count} skipped on purpose</em>}
                </div>
              </div>

              <div className="rec-stacks">
                <div className="rec-head">
                  <span />
                  <span>Stack</span>
                  <span className="num">Size</span>
                  <span>Status</span>
                  <span />
                </div>
                {stacks.map(({ p: project, st }) => {
                  const total = project.items.reduce((n, i) => n + (i.bytes || 0), 0);
                  const partial = project.items.some((i) => i.partial);
                  const dest = project.items.find((i) => i.protected_by)?.protected_by?.dest;
                  const pickable = !project.settled && !project.ignored && project.items.length > 0;
                  return (
                    <details key={project.project} className={`rec-stack rec-stack--${st.tone}`}>
                      <summary>
                        {pickable ? (
                          <input
                            type="checkbox"
                            aria-label={`Back up ${project.project}`}
                            checked={chosen?.has(project.project) || false}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const next = new Set(chosen);
                              if (e.target.checked) next.add(project.project);
                              else next.delete(project.project);
                              setChosen(next);
                            }}
                          />
                        ) : (
                          <span className={`status-dot status-dot--${st.tone}`} />
                        )}
                        <strong title={project.working_dir || undefined}>{project.project}</strong>
                        <span className="num">{project.items.length ? `${formatBytes(total)}${partial ? "+" : ""}` : ""}</span>
                        <span className={`rec-state rec-state--${st.tone}`} title={project.ignored?.reason || undefined}>
                          {st.label}
                          {dest && st.tone !== "bad" ? ` → ${dest}` : ""}
                        </span>
                        <span className="rec-act" onClick={(e) => e.stopPropagation()}>
                          {project.ignored ? (
                            <button
                              type="button"
                              className="btn btn--sm btn--ghost"
                              onClick={async () => {
                                await unignore(host, project.project);
                                await load();
                              }}
                            >
                              Undo
                            </button>
                          ) : pickable ? (
                            <button
                              type="button"
                              className="btn btn--sm btn--ghost"
                              onClick={() => skip([project.project], project.project, "replaced by this dashboard")}
                            >
                              Skip
                            </button>
                          ) : null}
                        </span>
                      </summary>
                      {project.items.length > 0 && (
                        <ul className="rec-items">
                          {project.items.map((item) => {
                            const tone = item.protected_by ? (item.protected_by.state === "ok" ? "ok" : "warn") : item.ignored ? "none" : "bad";
                            return (
                              <li key={item.kind + item.name}>
                                <span className={`status-dot status-dot--${tone}`} />
                                <code title={item.name}>{item.name}</code>
                                <span className="num">
                                  {formatBytes(item.bytes)}
                                  {item.partial ? "+" : ""}
                                </span>
                                <span className="rec-cover">
                                  {item.ignored
                                    ? `Skipped${item.ignored.reason ? ` — ${item.ignored.reason}` : ""}`
                                    : item.protected_by
                                      ? `${item.protected_by.job} → ${item.protected_by.dest}`
                                      : item.allowed === false
                                        ? "Not backed up — this host doesn't allow that folder yet"
                                        : "Not backed up"}
                                </span>
                                <span className="rec-act">
                                  {item.ignored && !project.ignored ? (
                                    <button
                                      type="button"
                                      className="btn btn--sm btn--ghost"
                                      onClick={async () => {
                                        await unignore(host, item.name);
                                        await load();
                                      }}
                                    >
                                      Undo
                                    </button>
                                  ) : !item.ignored && !item.protected_by ? (
                                    <button
                                      type="button"
                                      className="btn btn--sm btn--ghost"
                                      onClick={() => skip([item.name], item.name, "regenerates / re-acquirable")}
                                    >
                                      Skip
                                    </button>
                                  ) : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </details>
                  );
                })}
              </div>

              {gaps > 0 && (
                <div className="rec-protect">
                  {dests && dests.length === 0 ? (
                    <p className="settings-hint">
                      No other host can store backups yet. Set a backup directory on one of them
                      first — a copy on this machine dies with this machine.
                    </p>
                  ) : (
                    <>
                      <label className="recovery-dest">
                        <span>Send to</span>
                        <select value={destHost} onChange={(e) => setDestHost(e.target.value)}>
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
                        className="btn btn--primary"
                        disabled={busy || !destHost || !chosen?.size}
                        onClick={protect}
                      >
                        {busy ? "Working…" : `Back up ${chosen?.size || 0} ticked stack${chosen?.size === 1 ? "" : "s"}`}
                      </button>
                    </>
                  )}

                  {result && (
                    <div className="recovery-result">
                      {result.created.length > 0 && (
                        <p>Created {result.created.length} job{result.created.length > 1 ? "s" : ""}.</p>
                      )}
                      {result.already_covered.length > 0 && (
                        <p className="settings-hint">{result.already_covered.length} already covered.</p>
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
                <summary>How to rebuild this host</summary>
                <ol>
                  <li>
                    Install the agent on the replacement and join it with the same host name — the
                    Overview's <strong>Add a node</strong> gives the command.
                  </li>
                  <li>
                    Clone the compose-file backup
                    {data.config_backup?.repo ? (
                      <> (<code>{data.config_backup.repo}</code>)</>
                    ) : null}{" "}
                    and put each project back where it was.
                  </li>
                  <li>
                    Restore each stack's data from its archives — every backup job's Archives panel
                    spells out the exact commands.
                  </li>
                  <li>
                    <code>docker compose up -d</code> per project, oldest dependency first.
                  </li>
                </ol>
                {data.source_dirs?.length === 0 && (
                  <p className="settings-hint">
                    This host allows no directories to be backed up yet. Allow some in its agent
                    settings (God mode → System → Settings), then add jobs from the Backups tab.
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
