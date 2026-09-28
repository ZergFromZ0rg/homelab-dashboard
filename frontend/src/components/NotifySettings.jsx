import { useEffect, useState } from "react";
import { jsonOrThrow } from "./apiAuth";

// Settings → Notifications: alerts on your phone through ntfy. Turning it
// on picks a random topic; scan the code with the phone (ntfy app
// installed) to subscribe. On a public server the topic is the secret —
// "New topic" if it ever leaks.

const api = (method, path = "", body) =>
  fetch(`/api/notify${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(jsonOrThrow);

function Qr({ text }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      if (live) setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    });
    return () => {
      live = false;
    };
  }, [text]);
  // The library's own SVG markup for a string we built: safe to inline.
  return <div className="notify-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function NotifySettings() {
  const [cfg, setCfg] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("GET").then(setCfg).catch((e) => setNote({ tone: "bad", text: e.message }));
  }, []);

  const change = async (changes) => {
    setBusy(true);
    setNote(null);
    try {
      setCfg(await api("PUT", "", changes));
    } catch (e) {
      setNote({ tone: "bad", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api("POST", "/test");
      setNote({ tone: "ok", text: "Sent — it should be on your phone now." });
    } catch (e) {
      setNote({ tone: "bad", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <p className="notify-dim">Loading…</p>;
  const url = cfg.topic ? `${cfg.server}/${cfg.topic}` : "";

  return (
    <div className="notify">
      <label className="settings-row">
        <span>Send alerts to my phone</span>
        <input type="checkbox" checked={cfg.enabled} disabled={busy} onChange={(e) => change({ enabled: e.target.checked })} />
      </label>

      {cfg.enabled && url && (
        <>
          <div className="notify-subscribe">
            <Qr text={url} />
            <div>
              <p>
                Install <strong>ntfy</strong> on your phone, then scan this — or open{" "}
                <a href={url} target="_blank" rel="noopener noreferrer">the topic</a> there and subscribe.
              </p>
              <code className="notify-topic" title="Anyone with this topic can read along — New topic if it leaks">
                {cfg.topic}
              </code>
            </div>
          </div>

          <label className="settings-row">
            <span>Tell me about</span>
            <select value={cfg.min_severity} disabled={busy} onChange={(e) => change({ min_severity: e.target.value })}>
              <option value="warn">warnings and problems</option>
              <option value="bad">problems only</option>
            </select>
          </label>

          <label className="settings-row settings-row--stack">
            <span>ntfy server</span>
            <input
              className="deploy-input"
              defaultValue={cfg.server}
              onBlur={(e) => e.target.value !== cfg.server && change({ server: e.target.value })}
              spellCheck={false}
            />
          </label>

          <div className="notify-actions">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={test}>Send a test</button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => window.confirm("Make a new topic? Phones subscribed to the old one stop getting alerts.") && change({ new_topic: true })}
            >
              New topic
            </button>
          </div>
        </>
      )}
      {note && <p className={note.tone === "ok" ? "notify-ok" : "cred-error"}>{note.text}</p>}
    </div>
  );
}

export default NotifySettings;
