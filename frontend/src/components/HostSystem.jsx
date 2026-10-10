import { useCallback, useEffect, useRef, useState } from "react";
import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";
import Icon from "./Icon";

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
  const [busy, setBusy] = useState(null); // { unit, action }
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
    setBusy({ unit, action });
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
              {(() => {
                const mine = busy?.unit === r.unit ? busy.action : null;
                const btn = (action, label) => (
                  <button type="button" disabled={busy?.unit === r.unit} aria-busy={mine === action || undefined} onClick={() => act(r.unit, action)}>
                    {mine === action ? ({ restart: "restarting…", stop: "stopping…", start: "starting…" })[action] : label}
                  </button>
                );
                return r.active === "active" ? (
                  <>
                    {btn("restart", "restart")}
                    {!r.protected && btn("stop", "stop")}
                  </>
                ) : (
                  btn(r.active === "failed" ? "restart" : "start", r.active === "failed" ? "restart" : "start")
                );
              })()}
            </span>
            {journal?.unit === r.unit && <pre className="hsys-journal">{journal.text}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The whole machine's journal — every service and the kernel — the place
// to look when something is wrong and it isn't one container.
function Journal({ host }) {
  const [priority, setPriority] = useState("warning");
  const [since, setSince] = useState("24h");
  const [grep, setGrep] = useState("");
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (query) => {
      const params = new URLSearchParams({ priority, since, lines: "1000" });
      if (query) params.set("grep", query);
      Promise.resolve()
        .then(() => {
          setBusy(true);
          return get(`${base(host)}/journal?${params}`);
        })
        .then((b) => setText(b.log.trim() || "Nothing matches."))
        .catch((e) => setText(e.message))
        .finally(() => setBusy(false));
    },
    [host, priority, since]
  );

  useEffect(() => {
    load(grep);
    // Reload when the filters change; the search waits for Enter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const lines = text ? text.split("\n") : [];
  return (
    <div className="hsys-block">
      <div className="hsys-head">
        <h4>Journal</h4>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="How serious">
          <option value="err">errors</option>
          <option value="warning">warnings and errors</option>
          <option value="info">everything</option>
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value)} aria-label="How far back">
          <option value="15m">last 15 min</option>
          <option value="1h">last hour</option>
          <option value="24h">last 24 hours</option>
          <option value="7d">last 7 days</option>
        </select>
        <input
          className="deploy-input hsys-search"
          type="search"
          placeholder="Search — Enter"
          value={grep}
          onChange={(e) => setGrep(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(grep)}
        />
        <span className="settings-hint">{busy ? "Reading…" : text != null ? `${lines.length} lines` : ""}</span>
      </div>
      {text != null && (
        <pre className="hsys-journal hsys-journal--tall">
          {lines.map((line, i) => (
            <span key={i} className={/\b(error|fail|failed|critical|panic)\b/i.test(line) ? "hsys-line-bad" : /\bwarn/i.test(line) ? "hsys-line-warn" : undefined}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function OsUpdates({ host, facts, autoCheck = false }) {
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

  // Opened from a "Details" link: list the packages straight away.
  useEffect(() => {
    if (autoCheck) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when opened
  }, []);

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
        <button type="button" className="btn btn--sm" aria-busy={checking || undefined} disabled={checking || upgrading} onClick={check}>
          {checking ? "Checking…" : "Check now"}
        </button>
        <button type="button" className="btn btn--sm btn--primary" aria-busy={upgrading || undefined} disabled={upgrading || !(list?.length || facts.os_updates)} onClick={install}>
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

// After a power action, follow the machine itself: waiting for it to go
// down, down, back up (a reboot) — read from the same online/uptime the cards
// already poll, so the Power panel shows it happening instead of a promise.
function Power({ host, machine }) {
  const [note, setNote] = useState(null);
  const [run, setRun] = useState(null); // { action, since, baseUptime, sawDown, backAt }
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run]);

  const online = machine?.online;
  const uptime = machine?.uptime;
  useEffect(() => {
    if (!run) return;
    const rebooted = uptime != null && run.baseUptime != null && uptime < run.baseUptime - 5;
    if (!online && !run.sawDown) setRun((r) => r && { ...r, sawDown: true });
    else if (run.action === "reboot" && run.sawDown && online && !run.backAt) setRun((r) => r && { ...r, backAt: Date.now() });
    else if (run.action === "reboot" && rebooted && !run.backAt) setRun((r) => r && { ...r, sawDown: true, backAt: Date.now() });
  }, [online, uptime, run]);

  const act = async (action) => {
    const word = action === "reboot" ? "reboot" : "power off";
    const typed = window.prompt(`${word[0].toUpperCase()}${word.slice(1)} ${host}? Everything on it stops${action === "poweroff" ? ", and it stays off until someone presses its power button" : ""}.\n\nType the host name to confirm:`);
    if (typed == null) return;
    if (typed.trim() !== host) return setNote({ tone: "bad", text: "The name didn't match — nothing happened." });
    try {
      await change(`${base(host)}/power`, { action });
      setNote(null);
      setNow(Date.now());
      setRun({ action, since: Date.now(), baseUptime: uptime ?? null, sawDown: false, backAt: null });
    } catch (e) {
      setRun(null);
      setNote({ tone: "bad", text: e.message });
    }
  };

  let status = null;
  if (run) {
    const secs = Math.max(0, Math.round(((run.backAt || now) - run.since) / 1000));
    const word = run.action === "reboot" ? "reboot" : "power off";
    if (run.backAt) status = { tone: "ok", text: `${host} is back online after ${secs}s.`, done: true };
    else if (run.sawDown && run.action === "poweroff") status = { tone: "ok", text: `${host} is off.`, done: true };
    else if (run.sawDown) status = { tone: "wait", text: `${host} is down, waiting for it to come back… ${secs}s` };
    else if (secs > 120) status = { tone: "bad", text: `${host} hasn't gone down after ${secs}s — the ${word} may not have started.`, done: true };
    else status = { tone: "wait", text: `${host} will ${word} in a few seconds… ${secs}s` };
  }

  return (
    <div className="hsys-block hsys-power">
      <h4>Power</h4>
      <button type="button" className="btn btn--sm" disabled={run && !status.done} onClick={() => act("reboot")}>Reboot</button>
      <button type="button" className="btn btn--sm btn--danger" disabled={run && !status.done} onClick={() => act("poweroff")}>Power off</button>
      {status && (
        <span className={status.tone === "bad" ? "form-error" : status.tone === "ok" ? "hsys-ok" : "hsys-ok hsys-wait"}>
          {status.tone === "wait" && <span className="hsys-spin" aria-hidden="true" />}
          {status.text}
        </span>
      )}
      {status?.done && <button type="button" className="btn btn--sm" onClick={() => setRun(null)}>Dismiss</button>}
      {note && <span className={note.tone === "ok" ? "hsys-ok" : "form-error"}>{note.text}</span>}
    </div>
  );
}

export { Services, Journal, OsUpdates, Power };

// The blocks on their own — the God-mode System tab shows them all open.
// `tabbed` (the server card on Advanced) shows one at a time under a tab bar,
// opening on whatever most needs a look: the updates you came for, failed
// services, pending updates, else the services.
export function HostSystemPanels({ host, machine, autoCheckUpdates = false, tabbed = false }) {
  const facts = machine.host_facts;
  const failed = facts?.failed_units?.length || 0;
  const pending = facts?.os_updates || 0;
  const [tab, setTab] = useState(autoCheckUpdates || (!failed && pending) ? "updates" : "services");

  const panels = {
    services: <Services host={host} />,
    journal: <Journal host={host} />,
    updates: <OsUpdates host={host} facts={facts} autoCheck={autoCheckUpdates} />,
    power: <Power host={host} machine={machine} />,
  };

  if (!tabbed) {
    return (
      <div className="hsys">
        {panels.services}
        {panels.journal}
        {panels.updates}
        {panels.power}
      </div>
    );
  }

  const tabs = [
    ["updates", "OS updates", pending || null, facts?.security_updates ? "warn" : null],
    ["services", "Services", failed || null, "bad"],
    ["journal", "Journal", null, null],
    ["power", "Power", facts?.reboot_required ? "!" : null, "warn"],
  ];

  return (
    <div className="hsys hsys--tabbed">
      <div className="hsys-tabs" role="tablist" aria-label="System">
        {tabs.map(([id, label, badge, tone]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
            {badge != null && <span className={`hsys-badge ${tone ? `hsys-badge--${tone}` : ""}`}>{badge}</span>}
          </button>
        ))}
      </div>
      <div className="hsys-pane">{panels[tab]}</div>
    </div>
  );
}

// `showUpdates` is a counter the host card bumps when a link elsewhere (the
// Simple page's "Details") asks for the OS updates: open, and list them.
function HostSystem({ host, machine, showUpdates = 0, open: openProp, onToggle }) {
  const [openState, setOpen] = useState(showUpdates > 0);
  const open = openProp ?? openState;
  const [fromLink, setFromLink] = useState(showUpdates > 0);
  const section = useRef(null);
  useEffect(() => {
    if (!showUpdates) return;
    setOpen(true);
    setFromLink(true);
    setTimeout(() => section.current?.querySelector(".hsys")?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
  }, [showUpdates]);
  if (!machine.terminal) return null;
  const facts = machine.host_facts;
  const failed = facts?.failed_units?.length || 0;

  return (
    <section className="conn" ref={section}>
      <button type="button" className={`conn-toggle ${open ? "expanded" : ""}`} onClick={() => (onToggle ? onToggle() : setOpen(!open))} aria-expanded={open}>
        <span className="host-toggle" aria-hidden="true"><Icon name="chevron" size={12} /></span>
        SYSTEM
        {failed > 0 && <span className="conn-count conn-count--bad">{failed} failed</span>}
      </button>
      {open && <HostSystemPanels key={showUpdates} host={host} machine={machine} autoCheckUpdates={fromLink} tabbed />}
    </section>
  );
}

export default HostSystem;
