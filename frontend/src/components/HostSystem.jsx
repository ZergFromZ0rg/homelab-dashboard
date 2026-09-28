import { useCallback, useEffect, useState } from "react";
import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";

// The machine under the containers, on its server card: systemd services
// (failed first), OS package updates, reboot and power off. Reading is a
// click; anything that changes the machine asks for Face ID / Touch ID
// (once per few minutes) and says what it did. The agent runs upgrades and
// power actions as systemd units on the host, so they survive Docker
// restarting in the middle of them.

const base = (host) => `/api/hosts/${encodeURIComponent(host)}`;
const get = (url) => fetch(url).then(jsonOrThrow);
const change = (url, body) =>
  confirmedFetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(jsonOrThrow);

function Services({ host }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [journal, setJournal] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () => get(`${base(host)}/services`).then((b) => setRows(b.services)).catch((e) => setError(e.message)),
    [host]
  );
  useEffect(() => {
    load();
  }, [load]);

  const act = async (unit, action) => {
    if (action !== "start" && !window.confirm(`${action} ${unit} on ${host}?`)) return;
    setBusy(unit);
    setError("");
    try {
      const result = await change(`${base(host)}/services/${encodeURIComponent(unit)}/${action}`);
      if (!result.ok) setError(`${unit}: ${result.output?.trim().split("\n").at(-1) || "didn't work"}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      load();
    }
  };

  const showJournal = async (unit) => {
    if (journal?.unit === unit) return setJournal(null);
    setJournal({ unit, text: "Reading…" });
    try {
      const body = await get(`${base(host)}/services/${encodeURIComponent(unit)}/logs?lines=200`);
      setJournal({ unit, text: body.log || "(empty)" });
    } catch (e) {
      setJournal({ unit, text: e.message });
    }
  };

  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter(
    (r) =>
      (needle ? `${r.unit} ${r.description}`.toLowerCase().includes(needle) : r.active !== "inactive") &&
      r.load !== "not-found"
  );

  return (
    <div className="hsys-block">
      <div className="hsys-head">
        <h4>Services</h4>
        <input
          className="deploy-input hsys-search"
          type="search"
          placeholder={`Filter ${rows?.length ?? ""} — inactive ones show when you search`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      {!rows && !error && <p className="settings-hint">Reading…</p>}
      {rows?.length === 0 && <p className="settings-hint">No systemd services found on this machine.</p>}
      <ul className="hsys-list">
        {shown.map((r) => (
          <li key={r.unit} className={r.active === "failed" ? "hsys-failed" : ""} title={r.description}>
            <span className={`hsys-dot hsys-dot--${r.active}`} />
            <span className="hsys-unit">{r.unit.replace(/\.service$/, "")}</span>
            <span className="hsys-sub">{r.sub}</span>
            <span className="hsys-actions">
              <button type="button" onClick={() => showJournal(r.unit)}>journal</button>
              {r.active === "active" ? (
                <>
                  <button type="button" disabled={busy === r.unit} onClick={() => act(r.unit, "restart")}>restart</button>
                  {!r.protected && (
                    <button type="button" disabled={busy === r.unit} onClick={() => act(r.unit, "stop")}>stop</button>
                  )}
                </>
              ) : (
                <button type="button" disabled={busy === r.unit} onClick={() => act(r.unit, r.active === "failed" ? "restart" : "start")}>
                  {r.active === "failed" ? "restart" : "start"}
                </button>
              )}
            </span>
            {journal?.unit === r.unit && <pre className="hsys-journal">{journal.text}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OsUpdates({ host, facts }) {
  const [list, setList] = useState(null);
  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      setList((await get(`${base(host)}/os-updates`)).packages);
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  };

  // Follow a running upgrade (started here, or already running when the
  // panel opened) until the unit on the host finishes.
  const upgrading = run?.running || (run == null && facts?.upgrading);
  useEffect(() => {
    if (!upgrading) return undefined;
    const timer = setTimeout(
      () => get(`${base(host)}/os-updates/status`).then(setRun).catch(() => setRun((r) => ({ ...(r || {}), running: true }))),
      run ? 3000 : 0
    );
    return () => clearTimeout(timer);
  }, [host, upgrading, run]);

  const install = async () => {
    const count = list?.length ?? facts?.os_updates;
    if (!window.confirm(`Install ${count ?? "all"} package updates on ${host}? Services may restart; Docker may too.`)) return;
    setError("");
    try {
      await change(`${base(host)}/os-updates/upgrade`);
      setRun({ running: true, log: "" });
    } catch (e) {
      setError(e.message);
    }
  };

  if (!facts?.package_manager) {
    return (
      <div className="hsys-block">
        <h4>OS updates</h4>
        <p className="settings-hint">Only apt (Debian / Ubuntu) hosts can be updated from here.</p>
      </div>
    );
  }

  return (
    <div className="hsys-block">
      <div className="hsys-head">
        <h4>OS updates</h4>
        <span className="settings-hint">
          {facts.os_updates != null && `${facts.os_updates} pending${facts.security_updates ? `, ${facts.security_updates} security` : ""}`}
          {facts.reboot_required && " · reboot needed"}
        </span>
        <button type="button" className="btn btn--sm" disabled={checking || upgrading} onClick={check}>
          {checking ? "Checking…" : "Check now"}
        </button>
        <button type="button" className="btn btn--sm btn--primary" disabled={upgrading || !(list?.length || facts.os_updates)} onClick={install}>
          {upgrading ? "Installing…" : "Install"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {list && !run && (
        <ul className="hsys-packages">
          {list.length === 0 && <li className="settings-hint">Up to date.</li>}
          {list.map((p) => (
            <li key={p.name} className={p.security ? "hsys-security" : ""} title={`${p.from} → ${p.version}`}>
              {p.name}
              {p.security && <span className="chip chip--bad">security</span>}
            </li>
          ))}
        </ul>
      )}
      {run && (
        <>
          {!run.running && (
            <p className={run.exit_code === 0 ? "hsys-ok" : "form-error"}>
              {run.exit_code === 0 ? "Installed." : `apt finished with code ${run.exit_code ?? "?"}.`}
              {facts.reboot_required && " A reboot is needed to finish."}
            </p>
          )}
          <pre className="hsys-journal">{run.log || "Starting…"}</pre>
        </>
      )}
    </div>
  );
}

function Power({ host }) {
  const [note, setNote] = useState(null);
  const act = async (action) => {
    const word = action === "reboot" ? "reboot" : "power off";
    const typed = window.prompt(`${word[0].toUpperCase()}${word.slice(1)} ${host}? Everything on it stops${action === "poweroff" ? ", and it stays off until someone presses its power button" : ""}.\n\nType the host name to confirm:`);
    if (typed == null) return;
    if (typed.trim() !== host) return setNote({ tone: "bad", text: "The name didn't match — nothing happened." });
    try {
      await change(`${base(host)}/power`, { action });
      setNote({ tone: "ok", text: `${host} will ${word} in a few seconds.` });
    } catch (e) {
      setNote({ tone: "bad", text: e.message });
    }
  };
  return (
    <div className="hsys-block hsys-power">
      <h4>Power</h4>
      <button type="button" className="btn btn--sm" onClick={() => act("reboot")}>Reboot</button>
      <button type="button" className="btn btn--sm btn--danger" onClick={() => act("poweroff")}>Power off</button>
      {note && <span className={note.tone === "ok" ? "hsys-ok" : "form-error"}>{note.text}</span>}
    </div>
  );
}

function HostSystem({ host, machine }) {
  const [open, setOpen] = useState(false);
  if (!machine.terminal) return null;
  const facts = machine.host_facts;
  const failed = facts?.failed_units?.length || 0;

  return (
    <section className="conn">
      <button type="button" className={`conn-toggle ${open ? "expanded" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="host-toggle">▾</span>
        SYSTEM
        {failed > 0 && <span className="conn-count conn-count--bad">{failed} failed</span>}
      </button>
      {open && (
        <div className="hsys">
          <Services host={host} />
          <OsUpdates host={host} facts={facts} />
          <Power host={host} />
        </div>
      )}
    </section>
  );
}

export default HostSystem;
