import { useCallback, useEffect, useRef, useState } from "react";
import Icon, { IconButton } from "./Icon";
import FileViewer from "./FileViewer";
import { deleteDiskPath, fetchDiskUsage } from "./diskApi";
import { downloadUrl, listFolder, makeFolder, renameEntry, uploadFile } from "./filesApi";
import { formatAge, formatBytes } from "./format";
import { useNow } from "./useNow";

// The file browser, grown out of the disk explorer: a folder's contents
// with what each takes on disk, biggest first by default (click a header to
// sort by name or date). Folders open in place; files open in a viewer or
// the config editor. Upload (button or drop), new folder and rename work
// inside the host's writable roots — its owner's home and the compose
// stack folders — and the header says "read-only" (with why) elsewhere.
// Download works everywhere; a folder comes as a .tar.gz. Delete keeps its
// own rules (system paths, mount points and folders in use are refused).
//
// Two sources per folder: the agent's listing (every name, instant) and its
// disk-usage scan (folder totals, filled in as a background walk finishes).

const POLL_MS = 1200;
const ICON = { dir: "📁", mount: "💽", link: "↪", file: "📄", other: "·" };

const join = (dir, name) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

// Click a part to go up to it; double-click the trail to type a path.
function Crumbs({ path, onGo }) {
  const [typing, setTyping] = useState(null);
  const parts = path.split("/").filter(Boolean);

  if (typing != null) {
    return (
      <input
        className="dx-path-input"
        autoFocus
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onBlur={() => setTyping(null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setTyping(null);
          if (e.key === "Enter" && typing.trim().startsWith("/")) {
            onGo(typing.trim().replace(/\/+/g, "/").replace(/(.)\/$/, "$1"));
            setTyping(null);
          }
        }}
        aria-label="Go to path"
      />
    );
  }

  return (
    <span className="dx-crumbs" onDoubleClick={() => setTyping(path)} title="Double-click to type a path">
      <button type="button" onClick={() => onGo("/")}>/</button>
      {parts.map((part, i) => {
        const to = `/${parts.slice(0, i + 1).join("/")}`;
        return (
          <span key={to}>
            <button type="button" onClick={() => onGo(to)} disabled={i === parts.length - 1}>
              {part}
            </button>
            {i < parts.length - 1 && <span className="dx-sep">/</span>}
          </span>
        );
      })}
    </span>
  );
}

function SortHead({ label, field, sort, onSort, className }) {
  const active = sort.field === field;
  return (
    <th className={className}>
      <button
        type="button"
        className={`dx-sort ${active ? "dx-sort--on" : ""}`}
        onClick={() => onSort(field)}
      >
        {label}
        {active && (sort.desc ? " ↓" : " ↑")}
      </button>
    </th>
  );
}

function sorter({ field, desc }) {
  const sign = desc ? -1 : 1;
  return (a, b) => {
    if (field === "name") return sign * a.name.localeCompare(b.name);
    const x = field === "size" ? a.bytes : a.modified;
    const y = field === "size" ? b.bytes : b.modified;
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    return sign * (x - y);
  };
}

function DiskExplorer({ host, start = "~", onClose }) {
  const [path, setPath] = useState(start);
  // Answers kept per folder, so one arriving late for a folder you've
  // already left can't overwrite the one on screen.
  const [listings, setListings] = useState({});
  const [usages, setUsages] = useState({});
  const [sort, setSort] = useState({ field: "size", desc: true });
  const [opened, setOpened] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const root = useRef(null);
  const now = useNow(10000).getTime() / 1000;
  const absolute = path.startsWith("/");

  const list = useCallback(
    () =>
      listFolder(host, path)
        .then((body) => {
          setListings((all) => ({ ...all, [body.path]: body }));
          // "~" resolves to the owner's home: show where that is.
          if (body.path !== path) setPath(body.path);
        })
        .catch((e) => setListings((all) => ({ ...all, [path]: { error: e.message, entries: [] } }))),
    [host, path]
  );

  const scan = useCallback(
    (refresh = false) =>
      fetchDiskUsage(host, path, { refresh })
        .then((body) => {
          setUsages((all) => ({ ...all, [path]: body }));
          return body;
        })
        .catch(() => {
          setUsages((all) => ({ ...all, [path]: { state: "error", entries: [] } }));
          return null;
        }),
    [host, path]
  );

  useEffect(() => {
    list();
  }, [list]);

  // Opened from the card header, it appears at the bottom of a tall card.
  useEffect(() => {
    root.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  // Sizes: fetch on every change of folder and keep polling while the
  // agent's scan is still walking.
  useEffect(() => {
    if (!absolute) return undefined;
    let live = true;
    let timer;
    const tick = (refresh) =>
      scan(refresh).then((body) => {
        if (live && body?.state === "scanning") timer = setTimeout(() => tick(false), POLL_MS);
      });
    tick(false);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scan, absolute]);

  // Size again from scratch — after anything that changed the folder, the
  // agent's cached scan no longer adds up.
  const resize = () => {
    const poll = (refresh) =>
      scan(refresh).then((body) => {
        if (body?.state === "scanning") setTimeout(() => poll(false), POLL_MS);
      });
    poll(true);
  };

  const reload = () => {
    list();
    resize();
  };

  const data = listings[path] ?? null;
  const sizes = usages[path]?.state === "error" ? null : usages[path] ?? null;
  const sizing = absolute && !usages[path];
  const bySize = new Map((sizes?.entries || []).map((e) => [e.path, e]));
  const writable = Boolean(data?.writable);

  const entries = (data?.entries || [])
    .map((e) => {
      const u = bySize.get(e.path);
      return {
        ...e,
        bytes: u?.bytes ?? e.size ?? null,
        files: u?.files ?? null,
        pending: u?.pending ?? false,
        unreadable: u?.unreadable,
      };
    })
    .sort(sorter(sort));
  const total = Math.max(sizes?.total_bytes || 0, entries.reduce((n, e) => n + (e.bytes || 0), 0));
  const biggest = Math.max(1, ...entries.map((e) => e.bytes || 0));
  const scanning = sizes?.state === "scanning";

  const onSort = (field) =>
    setSort((s) => ({ field, desc: s.field === field ? !s.desc : field !== "name" }));

  const act = async (label, work, success) => {
    setBusy(label);
    setNotice(null);
    try {
      const result = await work();
      if (result?.success === false) throw new Error(result.error);
      if (success) setNotice({ tone: "ok", text: success(result) });
    } catch (e) {
      setNotice({ tone: "bad", text: e.message });
    } finally {
      setBusy(null);
      list();
      resize();
    }
  };

  const remove = (entry) => {
    const size = entry.bytes == null ? "unknown size" : formatBytes(entry.bytes);
    if (entry.kind === "dir") {
      const typed = window.prompt(
        `Delete the folder ${entry.path} and everything in it?\n` +
          `${size}${entry.files != null ? `, ${entry.files.toLocaleString()} files` : ""}. ` +
          "This can't be undone.\n\nType the folder name to confirm:"
      );
      if (typed == null) return;
      if (typed.trim() !== entry.name) {
        setNotice({ tone: "bad", text: "The name didn't match — nothing was deleted." });
        return;
      }
    } else if (!window.confirm(`Delete ${entry.path} (${size})? This can't be undone.`)) {
      return;
    }
    act(entry.path, () => deleteDiskPath(host, entry.path), (result) => {
      const freed = result.freed_bytes ?? entry.bytes;
      return `Deleted ${entry.path}${freed != null ? ` — freed ${formatBytes(freed)}` : ""}.`;
    });
  };

  const rename = (entry) => {
    const name = window.prompt(`Rename ${entry.name} to:`, entry.name);
    if (!name || name.trim() === entry.name) return;
    act(entry.path, () => renameEntry(host, entry.path, name.trim()), () => `Renamed to ${name.trim()}.`);
  };

  const newFolder = () => {
    const name = window.prompt("New folder name:");
    if (!name?.trim()) return;
    act("mkdir", () => makeFolder(host, join(path, name.trim())), () => `Made ${name.trim()}.`);
  };

  const upload = async (fileList) => {
    const queue = Array.from(fileList || []);
    if (!queue.length || !writable) return;
    setNotice(null);
    for (const [i, file] of queue.entries()) {
      const target = join(path, file.name);
      const label = queue.length > 1 ? `${file.name} (${i + 1}/${queue.length})` : file.name;
      const send = (overwrite) =>
        uploadFile(host, target, file, {
          overwrite,
          onProgress: (p) => setBusy(`Uploading ${label} · ${Math.round(p * 100)}%`),
        });
      setBusy(`Uploading ${label}`);
      try {
        try {
          await send(false);
        } catch (e) {
          if (!e.conflict || !window.confirm(`${file.name} already exists here. Replace it?`)) throw e;
          await send(true);
        }
      } catch (e) {
        setNotice({ tone: "bad", text: `${file.name}: ${e.message}` });
        break;
      }
    }
    setBusy(null);
    setNotice((n) => n ?? { tone: "ok", text: `Uploaded ${queue.length === 1 ? queue[0].name : `${queue.length} files`}.` });
    list();
    resize();
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    upload(event.dataTransfer.files);
  };

  const go = (to) => {
    setOpened(null);
    setNotice(null);
    setPath(to);
  };

  return (
    <section
      ref={root}
      className={`dx ${dragging ? "dx--drop" : ""}`}
      onDragOver={(e) => {
        if (!writable || opened || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="dx-head">
        <strong className="dx-title">Files</strong>
        {absolute ? <Crumbs path={path} onGo={go} /> : <span className="dx-crumbs">~</span>}
        {data && !writable && !data.error && (
          <span className="chip" title={data.why_not || undefined}>read-only</span>
        )}
        <span className="dx-status">
          {busy && !busy.startsWith("/") && busy !== "mkdir" ? busy : null}
          {!busy && sizing && "Sizing…"}
          {!busy && scanning && `Sizing… ${Math.round((sizes.items_scanned || 0) / 1000)}k items`}
          {!busy &&
            sizes?.state === "done" &&
            `${formatBytes(total)} · sized ${formatAge(now - (sizes.finished_at || now))}`}
        </span>
        {writable && !opened && (
          <>
            <IconButton icon="folderPlus" label="New folder" onClick={newFolder} disabled={Boolean(busy)} />
            <IconButton
              icon="upload"
              label="Upload files (or drop them here)"
              onClick={() => fileInput.current?.click()}
              disabled={Boolean(busy)}
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
        {!opened && (
          <IconButton icon="refresh" label="Reload and size again" onClick={reload} disabled={scanning} />
        )}
        {onClose && (
          <button type="button" className="dx-close" onClick={onClose} aria-label="Close files">
            ×
          </button>
        )}
      </div>

      {data?.error && <p className="dx-error">{data.error}</p>}
      {notice && (
        <div className={`dx-notice dx-notice--${notice.tone}`}>
          <span>{notice.text}</span>
          <button type="button" className="dx-close" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {opened ? (
        <FileViewer
          key={opened.path}
          host={host}
          entry={opened}
          onClose={() => setOpened(null)}
          onSaved={list}
        />
      ) : (
        <table className="dx-table">
          <thead>
            <tr>
              <SortHead label="Name" field="name" sort={sort} onSort={onSort} />
              <th className="dx-bar-col" />
              <SortHead label="Size" field="size" sort={sort} onSort={onSort} />
              <th>Share</th>
              <th>Files</th>
              <SortHead label="Modified" field="modified" sort={sort} onSort={onSort} />
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.parent != null && (
              <tr className="dx-row dx-row--up" onClick={() => go(data.parent)}>
                <td colSpan={7}>↑ ..</td>
              </tr>
            )}
            {entries.map((e) => {
              const folder = e.kind === "dir" || e.kind === "mount";
              const openable = folder || e.kind === "file";
              const share = total && e.bytes ? (e.bytes / total) * 100 : null;
              return (
                <tr
                  key={e.path}
                  className={`dx-row dx-row--${e.kind} ${openable ? "dx-row--open" : ""} ${
                    busy === e.path ? "dx-row--deleting" : ""
                  }`}
                  onClick={openable ? () => (folder ? go(e.path) : setOpened(e)) : undefined}
                  title={
                    e.kind === "mount"
                      ? "A different filesystem — open it to size it on its own"
                      : e.kind === "link"
                        ? `link → ${e.target ?? "?"}`
                        : e.unreadable
                          ? "Some folders under here couldn't be read"
                          : undefined
                  }
                >
                  <td className="dx-name">
                    <span className="dx-icon" aria-hidden="true">{ICON[e.kind] || "·"}</span>
                    {e.name}
                    {e.kind === "mount" && <span className="chip">mount</span>}
                    {e.kind === "link" && e.target && <span className="dx-dim"> → {e.target}</span>}
                  </td>
                  <td className="dx-bar-col">
                    {e.bytes != null && (
                      <span className="dx-bar">
                        <span
                          className={e.pending ? "dx-bar-fill dx-bar-fill--pending" : "dx-bar-fill"}
                          style={{ width: `${(e.bytes / biggest) * 100}%` }}
                        />
                      </span>
                    )}
                  </td>
                  <td className="dx-num">
                    {e.bytes == null ? "—" : formatBytes(e.bytes)}
                    {e.pending && <span className="dx-dim">…</span>}
                  </td>
                  <td className="dx-num dx-dim">{share == null ? "" : `${share.toFixed(share < 10 ? 1 : 0)}%`}</td>
                  <td className="dx-num dx-dim">{e.files == null ? "" : e.files.toLocaleString()}</td>
                  <td className="dx-dim">
                    {e.modified ? new Date(e.modified * 1000).toLocaleDateString() : ""}
                  </td>
                  <td className="dx-actions" onClick={(event) => event.stopPropagation()}>
                    {(e.kind === "file" || e.kind === "dir") && (
                      <a
                        className="icon-action"
                        href={downloadUrl(host, e.path)}
                        title={e.kind === "dir" ? `Download ${e.name} as .tar.gz` : `Download ${e.name}`}
                        aria-label={`Download ${e.name}`}
                      >
                        <Icon name="download" />
                      </a>
                    )}
                    {writable && e.kind !== "mount" && (
                      <IconButton
                        icon="edit"
                        label={`Rename ${e.name}`}
                        disabled={Boolean(busy)}
                        onClick={() => rename(e)}
                      />
                    )}
                    {e.kind !== "mount" && (
                      <IconButton
                        icon="trash"
                        label={busy === e.path ? "Working…" : `Delete ${e.name}`}
                        danger
                        disabled={Boolean(busy) || e.pending}
                        onClick={() => remove(e)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
            {data?.truncated && (
              <tr className="dx-row">
                <td colSpan={7} className="dx-dim">Only the first 5,000 entries are shown.</td>
              </tr>
            )}
            {data && !data.error && entries.length === 0 && (
              <tr>
                <td colSpan={7} className="dx-dim">
                  Empty.{writable && " Drop files here to upload."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default DiskExplorer;
