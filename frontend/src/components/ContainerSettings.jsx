import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyCompose, fetchComposeJob, fetchComposeSettings, previewCompose } from "./composeApi";
import { listFolder, makeFolder, saveText } from "./filesApi";
import {
  addEnv, addListItem, edit, parse, readService, removeEnv, removeListItem,
  setEnv, setListItem, setScalar,
} from "./yamlEdit";
import { hostColor } from "./hostColor";

const CodeEditor = lazy(() => import("./CodeEditor"));

// A container's settings, from the file that really defines them: its
// Compose file. Editing the container itself would be undone by the next
// `docker compose up`, so this edits the file and has Compose apply it.
//
// Settings tab: image, restart, environment, ports, volumes — each change
// rewrites only its own line (yamlEdit rebases onto the original text, so
// comments and formatting stay). YAML tab: the whole file. Review shows the
// diff with Compose's own verdict (`docker compose config`); Apply saves,
// runs `up -d`, watches the containers and rolls back if one doesn't come
// up. Lazy-loaded from the container row.

const RESTART = ["", "no", "always", "unless-stopped", "on-failure"];
const POLL_MS = 1500;

function Rows({ title, rows, placeholder, onChange, onRemove, onAdd, readOnly }) {
  return (
    <div className="cs-group">
      <div className="cs-group-head">
        <span>{title}</span>
        {!readOnly && rows && (
          <button type="button" className="cs-add" onClick={onAdd}>+ add</button>
        )}
      </div>
      {rows == null && <p className="cs-dim">Written in a form this view can't edit — use the YAML tab.</p>}
      {rows?.length === 0 && <p className="cs-dim">None.</p>}
      {rows?.map((row, i) =>
        row.editable === false ? (
          <div key={i} className="cs-row cs-row--fixed" title="Long syntax — edit it in the YAML tab">
            <code>{row.text}</code>
          </div>
        ) : (
          <div key={i} className="cs-row">
            <input
              value={row.text}
              placeholder={placeholder}
              readOnly={readOnly}
              onChange={(e) => onChange(i, e.target.value)}
              spellCheck={false}
            />
            {!readOnly && (
              <button type="button" className="cs-remove" onClick={() => onRemove(i)} aria-label="Remove">✕</button>
            )}
          </div>
        )
      )}
    </div>
  );
}

function ServiceForm({ text, service, readOnly, onText }) {
  const { doc, error } = useMemo(() => parse(text), [text]);
  if (error) return <p className="cs-error">The YAML doesn't parse — fix it in the YAML tab. {error}</p>;
  const svc = readService(doc, service);
  if (!svc) return <p className="cs-dim">This file doesn't define {service}. Pick the file that does, or use the YAML tab.</p>;

  const change = (fn) => onText(edit(text, fn));
  const env = svc.environment;

  return (
    <div className="cs-form">
      <label className="cs-field">
        <span>Image</span>
        <input
          value={svc.image ?? ""}
          readOnly={readOnly || svc.image == null}
          onChange={(e) => change((d) => setScalar(d, service, "image", e.target.value))}
          spellCheck={false}
        />
      </label>
      <label className="cs-field">
        <span>Restart</span>
        <select
          value={svc.restart ?? ""}
          disabled={readOnly || svc.restart == null}
          onChange={(e) => change((d) => setScalar(d, service, "restart", e.target.value))}
        >
          {RESTART.map((r) => (
            <option key={r} value={r}>{r || "(not set)"}</option>
          ))}
        </select>
      </label>

      <div className="cs-group">
        <div className="cs-group-head">
          <span>Environment</span>
          {!readOnly && env.items && (
            <button type="button" className="cs-add" onClick={() => change((d) => addEnv(d, service, "NAME", ""))}>
              + add
            </button>
          )}
        </div>
        {env.items == null && <p className="cs-dim">Written in a form this view can't edit — use the YAML tab.</p>}
        {env.items?.length === 0 && <p className="cs-dim">None.</p>}
        {env.items?.map((row, i) => (
          <div key={i} className="cs-row cs-row--env">
            <input
              value={row.key}
              readOnly={readOnly}
              onChange={(e) => change((d) => setEnv(d, service, i, e.target.value, row.value))}
              spellCheck={false}
            />
            <span className="cs-eq">=</span>
            <input
              value={row.value}
              readOnly={readOnly}
              placeholder={row.bare ? "(from the host's environment)" : ""}
              onChange={(e) => change((d) => setEnv(d, service, i, row.key, e.target.value))}
              spellCheck={false}
            />
            {!readOnly && (
              <button type="button" className="cs-remove" onClick={() => change((d) => removeEnv(d, service, i))} aria-label="Remove">✕</button>
            )}
          </div>
        ))}
      </div>

      {[
        ["Ports", "ports", "host:container"],
        ["Volumes", "volumes", "/host/path:/container/path"],
      ].map(([title, key, placeholder]) => (
        <Rows
          key={key}
          title={title}
          rows={svc[key].items}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(i, v) => change((d) => setListItem(d, service, key, i, v))}
          onRemove={(i) => change((d) => removeListItem(d, service, key, i))}
          onAdd={() => change((d) => addListItem(d, service, key, ""))}
        />
      ))}
    </div>
  );
}

function Diff({ text }) {
  if (!text) return <p className="cs-dim">No difference.</p>;
  return (
    <pre className="cs-diff">
      {text.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("+++") || line.startsWith("---")
              ? "cs-diff-file"
              : line.startsWith("+")
                ? "cs-diff-add"
                : line.startsWith("-")
                  ? "cs-diff-del"
                  : line.startsWith("@@")
                    ? "cs-diff-hunk"
                    : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function Job({ job }) {
  const done = job.state !== "running";
  return (
    <div className={`cs-job cs-job--${job.state}`}>
      <strong>
        {job.state === "running" && "Applying…"}
        {job.state === "done" && "Applied — every container is up."}
        {job.state === "rolled_back" && "Rolled back."}
        {job.state === "failed" && "Not applied."}
      </strong>
      {job.error && <p className="cs-job-error">{job.error}</p>}
      <ol className="cs-steps">
        {job.steps.map((s, i) => (
          <li key={i}>
            {s.text}
            {s.output && (
              <details>
                <summary>output</summary>
                <pre>{s.output}</pre>
              </details>
            )}
          </li>
        ))}
        {!done && <li className="cs-dim">…</li>}
      </ol>
      {job.failed?.logs && (
        <details open>
          <summary>{job.failed.name}: last log lines</summary>
          <pre>{job.failed.logs}</pre>
        </details>
      )}
    </div>
  );
}

function Generated({ host, data }) {
  const [note, setNote] = useState(null);

  const save = async () => {
    const home = (await listFolder(host, "~")).path;
    const suggestion = data.suggested_path.replace(/^~/, home);
    const path = window.prompt("Save the compose file as:", suggestion);
    if (!path) return;
    try {
      // mkdir -p, inside the writable roots.
      const parts = path.split("/").slice(0, -1);
      for (let i = 2; i <= parts.length; i += 1) {
        const dir = parts.slice(0, i).join("/");
        if (dir.length > home.length) {
          await makeFolder(host, dir).catch((e) => {
            if (!e.conflict) throw e;
          });
        }
      }
      await saveText(host, path, data.generated, null);
      setNote({ tone: "ok", text: `Saved ${path}. Stop ${data.container}, then run \`docker compose up -d\` there to switch it over.` });
    } catch (e) {
      setNote({ tone: "bad", text: e.message });
    }
  };

  return (
    <div className="cs-generated">
      <p className="cs-dim">
        {data.container} wasn't started by Compose, so there's no file to edit. Here's one that would
        recreate it — a starting point to check, not a guarantee.
      </p>
      <Suspense fallback={<p className="cs-dim">Loading…</p>}>
        <CodeEditor name="compose.yml" initial={data.generated} readOnly />
      </Suspense>
      <div className="cs-actions">
        <button type="button" className="btn btn--sm" onClick={() => navigator.clipboard?.writeText(data.generated)}>
          Copy
        </button>
        <button type="button" className="btn btn--sm" onClick={save}>Save as compose file…</button>
      </div>
      {note && <p className={`dx-notice dx-notice--${note.tone}`}>{note.text}</p>}
    </div>
  );
}

function ContainerSettings({ host, container, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [fileIndex, setFileIndex] = useState(null);
  const [text, setText] = useState(null);
  const [tab, setTab] = useState("settings");
  const [review, setReview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState(null);
  const panel = useRef(null);

  const load = useCallback(
    () =>
      // By name: applying recreates the container, and a new one has a new id.
      fetchComposeSettings(host, container.name)
        .then((body) => {
          setData(body);
          const files = body.files || [];
          const i = Math.max(0, files.findIndex((f) => f.defines_service));
          setFileIndex(i);
          setText(files[i]?.content ?? null);
          setReview(null);
        })
        .catch((e) => setError(e.message)),
    [host, container.name]
  );

  useEffect(() => {
    load();
    panel.current?.focus();
  }, [load]);

  const file = data?.files?.[fileIndex];
  const dirty = file && text != null && text !== file.content;
  const running = job?.state === "running";

  const close = useCallback(() => {
    if (running) return;
    if (dirty && !window.confirm("Discard your changes?")) return;
    onClose();
  }, [dirty, running, onClose]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Follow the job until it ends; then reload so the panel shows the file
  // as it now is on disk.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setTimeout(() => {
      fetchComposeJob(host, job.id)
        .then((next) => {
          setJob(next);
          if (next.state !== "running") load();
        })
        .catch(() => setJob((j) => ({ ...j }))); // the dashboard itself may be restarting
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [host, job, running, load]);

  const pickFile = (i) => {
    if (dirty && !window.confirm("Discard your changes to this file?")) return;
    setFileIndex(i);
    setText(data.files[i].content ?? null);
    setReview(null);
  };

  const check = async () => {
    setChecking(true);
    try {
      const result = await previewCompose(host, { container: container.name, path: file.path, content: text });
      setReview({ ...result, forText: text });
    } catch (e) {
      setReview({ valid: false, error: e.message, forText: text });
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    if (!window.confirm(`Apply this to ${data.project} on ${host}? Its containers will be recreated.`)) return;
    try {
      setJob(await applyCompose(host, {
        container: container.name, path: file.path, content: text, modified: file.modified,
      }));
    } catch (e) {
      setJob({ state: "failed", error: e.message, steps: [] });
    }
  };

  const reviewed = review && review.forText === text;
  const cantApply =
    !data?.can_apply ? data?.why_not
      : !file?.writable ? "this file is outside the folders the agent may write"
        : !reviewed ? "review the changes first"
          : !review.valid ? "Compose rejected this — see above"
            : null;

  // Portalled to <body>: opened from inside a container row, whose
  // ancestors animate (transform) and clip (overflow) — either would trap
  // a fixed-position panel inside the list.
  return createPortal(
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer drawer--wide cs" role="dialog" aria-modal="true" aria-label={`Settings for ${container.name}`} tabIndex={-1} ref={panel}>
        <div className="drawer-head">
          <h2>
            {container.name}
            <span className="chip chip--host" style={{ color: hostColor(host), borderColor: hostColor(host) }}>{host}</span>
          </h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)" disabled={running}>
            ✕
          </button>
        </div>

        <div className="drawer-body cs-body">
          {error && <p className="cs-error">{error}</p>}
          {!data && !error && <p className="cs-dim">Reading its compose file…</p>}

          {data?.compose === false && <Generated host={host} data={data} />}

          {data?.files && (
            <>
              <div className="cs-meta">
                <span title={data.working_dir}>
                  stack <strong>{data.project}</strong> · service <strong>{data.service}</strong>
                </span>
                {data.files.length > 1 ? (
                  <select value={fileIndex} onChange={(e) => pickFile(Number(e.target.value))}>
                    {data.files.map((f, i) => (
                      <option key={f.path} value={i}>
                        {f.path.split("/").pop()}{f.defines_service ? "" : " (doesn't define it)"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <code title={file?.path}>{file?.path.split("/").pop()}</code>
                )}
                {!data.can_apply && <span className="chip" title={data.why_not}>view only</span>}
              </div>

              {job && <Job job={job} />}

              {file?.error && <p className="cs-error">{file.path}: {file.error}</p>}

              {text != null && (
                <>
                  <div className="cs-tabs" role="tablist">
                    {["settings", "yaml"].map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="tab"
                        aria-selected={tab === t}
                        className={`cs-tab ${tab === t ? "cs-tab--on" : ""}`}
                        onClick={() => setTab(t)}
                      >
                        {t === "settings" ? "Settings" : "YAML"}
                      </button>
                    ))}
                  </div>

                  {tab === "settings" ? (
                    <ServiceForm text={text} service={data.service} readOnly={running} onText={setText} />
                  ) : (
                    <Suspense fallback={<p className="cs-dim">Loading editor…</p>}>
                      <CodeEditor
                        key={`${fileIndex}-${file.modified}`}
                        name={file.path.split("/").pop()}
                        initial={text}
                        readOnly={running}
                        onChange={setText}
                      />
                    </Suspense>
                  )}
                </>
              )}

              {reviewed && (
                <div className="cs-review">
                  {review.valid ? (
                    <p className="cs-ok">Compose accepts it.</p>
                  ) : (
                    <pre className="cs-error">{review.error}</pre>
                  )}
                  <Diff text={review.diff} />
                </div>
              )}

            </>
          )}
        </div>

        {data?.files && (
          <div className="cs-foot">
            <span className="cs-dim">{dirty ? "Unsaved changes" : "No changes"}</span>
            <button type="button" className="btn btn--sm" disabled={!dirty || running} onClick={() => { setText(file.content); setReview(null); }}>
              Discard
            </button>
            <button type="button" className="btn btn--sm" aria-busy={checking || undefined} disabled={!dirty || checking || running} onClick={check}>
              {checking ? "Checking…" : "Review changes"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              aria-busy={running || undefined}
              disabled={Boolean(cantApply) || !dirty || running}
              title={cantApply || "Save, recreate, watch — and roll back if it doesn't come up"}
              onClick={apply}
            >
              {running ? "Applying…" : "Apply"}
            </button>
          </div>
        )}
      </aside>
    </div>,
    document.body
  );
}

export default ContainerSettings;
