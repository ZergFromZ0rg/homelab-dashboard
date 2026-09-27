import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import Icon, { IconButton } from "./Icon";
import { downloadUrl, readText, saveText } from "./filesApi";
import { formatBytes } from "./format";

const CodeEditor = lazy(() => import("./CodeEditor"));

// One open file, inside the explorer: images, video, audio and PDFs play
// from the download route; anything else is tried as text and opens in the
// editor (read-only outside the writable roots). Cmd/Ctrl+S saves. A file
// changed on disk since it was opened is not overwritten — the agent
// refuses, and this offers to reload or overwrite.

const MEDIA = [
  ["image", /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i],
  ["video", /\.(mp4|webm|mov|m4v|mkv)$/i],
  ["audio", /\.(mp3|flac|wav|ogg|opus|m4a|aac)$/i],
  ["pdf", /\.pdf$/i],
];

function mediaKind(name) {
  return MEDIA.find(([, re]) => re.test(name))?.[0] ?? null;
}

function FileViewer({ host, entry, onClose, onSaved }) {
  const kind = mediaKind(entry.name);
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  // Bumped only when the file is (re)loaded from disk: a save keeps the
  // editor, its cursor and its undo history.
  const [version, setVersion] = useState(0);

  const fetchFile = useCallback(
    () =>
      readText(host, entry.path)
        .then((body) => {
          setFile(body);
          setVersion((v) => v + 1);
        })
        .catch((e) => setError(e.message)),
    [host, entry.path]
  );

  const load = () => {
    setFile(null);
    setDraft(null);
    setError("");
    setNotice(null);
    fetchFile();
  };

  useEffect(() => {
    if (!kind) fetchFile();
  }, [kind, fetchFile]);

  const dirty = draft != null && draft !== file?.content;

  const save = useCallback(
    async (content, { force = false } = {}) => {
      if (!file?.writable || saving) return;
      setSaving(true);
      setNotice(null);
      try {
        // No mtime = "overwrite whatever is there", only after asking.
        const result = await saveText(host, entry.path, content, force ? null : file.modified);
        setFile({ ...file, content, modified: result.modified, size: result.size });
        setDraft(null);
        setNotice({ tone: "ok", text: "Saved." });
        onSaved?.();
      } catch (e) {
        setNotice({ tone: "bad", text: e.message, conflict: e.conflict });
      } finally {
        setSaving(false);
      }
    },
    [file, saving, host, entry.path, onSaved]
  );

  const close = () => {
    if (dirty && !window.confirm(`Discard your changes to ${entry.name}?`)) return;
    onClose();
  };

  const url = downloadUrl(host, entry.path, { inline: true });

  return (
    <div className="fx">
      <div className="fx-head">
        <button type="button" className="fx-back" onClick={close} title="Back to the folder">
          ← {entry.name}
        </button>
        {dirty && <span className="fx-dirty" title="Unsaved changes">●</span>}
        {file && !file.writable && (
          <span className="chip" title={file.why_not || undefined}>read-only</span>
        )}
        {file?.size != null && <span className="dx-dim">{formatBytes(file.size)}</span>}
        <span className="fx-spacer" />
        {file?.writable && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={!dirty || saving}
            onClick={() => save(draft)}
            title="Save (⌘S / Ctrl+S)"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <a className="icon-action" href={downloadUrl(host, entry.path)} title="Download" aria-label="Download">
          <Icon name="download" />
        </a>
        <IconButton icon="refresh" label="Reload from disk" onClick={() => (kind ? setFile(null) : load())} />
      </div>

      {notice && (
        <div className={`dx-notice dx-notice--${notice.tone}`}>
          <span>{notice.text}</span>
          {notice.conflict && (
            <>
              <button type="button" className="btn btn--sm" onClick={load}>
                Reload theirs
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => save(draft ?? file.content, { force: true })}
              >
                Overwrite with mine
              </button>
            </>
          )}
        </div>
      )}

      <div className="fx-body">
        {kind === "image" && <img className="fx-media" src={url} alt={entry.name} />}
        {kind === "video" && <video className="fx-media" src={url} controls />}
        {kind === "audio" && <audio src={url} controls />}
        {kind === "pdf" && <iframe className="fx-frame" src={url} title={entry.name} />}
        {!kind && error && (
          <p className="fx-empty">
            {error}. <a href={downloadUrl(host, entry.path)}>Download</a>
          </p>
        )}
        {!kind && !error && !file && <p className="fx-empty">Opening…</p>}
        {!kind && file && (
          <Suspense fallback={<p className="fx-empty">Loading editor…</p>}>
            <CodeEditor
              key={version}
              name={entry.name}
              initial={file.content}
              readOnly={!file.writable}
              onChange={setDraft}
              onSave={(content) => save(content)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default FileViewer;
