import { useCallback, useEffect, useState } from "react";
import { IconButton } from "./Icon";
import { fetchDiskUsage } from "./diskApi";
import { formatAge, formatBytes } from "./format";
import { useNow } from "./useNow";

// What's taking the space: a folder's contents, biggest first, each with
// its share of the folder. Click a folder to go into it; the path at the top
// goes back up. The agent scans in the background, so a big folder shows
// "scanning" and fills in as each subfolder finishes.

const POLL_MS = 1200;
const ICON = { dir: "📁", mount: "💽", link: "↪", file: "📄", other: "·" };

function Crumbs({ path, onGo }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <span className="dx-crumbs">
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

function DiskExplorer({ host, start = "/", onClose }) {
  const [path, setPath] = useState(start);
  // The last answer, whichever folder it was for — only shown while it is
  // for the folder on screen, so changing folder needs no reset.
  const [answer, setAnswer] = useState(null);
  const now = useNow(10000).getTime() / 1000;

  const load = useCallback(
    (refresh = false) =>
      fetchDiskUsage(host, path, { refresh })
        .then((body) => {
          setAnswer({ path, body });
          return body;
        })
        .catch((e) => {
          setAnswer({ path, body: { state: "error", error: e.message, entries: [] } });
          return null;
        }),
    [host, path]
  );

  // Fetch on open and on every change of folder; keep polling while the
  // agent is still scanning.
  useEffect(() => {
    let live = true;
    let timer;

    const tick = (refresh) =>
      load(refresh).then((body) => {
        if (live && body?.state === "scanning") timer = setTimeout(() => tick(false), POLL_MS);
      });

    tick(false);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [load]);

  const rescan = () => {
    setAnswer(null);
    const poll = () =>
      load(false).then((body) => {
        if (body?.state === "scanning") setTimeout(poll, POLL_MS);
      });
    load(true).then((body) => {
      if (body?.state === "scanning") setTimeout(poll, POLL_MS);
    });
  };

  const data = answer?.path === path ? answer.body : null;
  const error = data?.state === "error" ? data.error : "";
  const entries = data?.entries || [];
  const total = data?.total_bytes || 0;
  const biggest = Math.max(1, ...entries.map((e) => e.bytes || 0));
  const scanning = data?.state === "scanning";

  return (
    <section className="dx">
      <div className="dx-head">
        <strong className="dx-title">Disk explorer</strong>
        <Crumbs path={path} onGo={setPath} />
        <span className="dx-status">
          {!data && !error && "Reading…"}
          {scanning && `Scanning… ${Math.round((data.items_scanned || 0) / 1000)}k items`}
          {data?.state === "done" &&
            `${formatBytes(total)} · scanned ${formatAge(now - (data.finished_at || now))}`}
        </span>
        <IconButton icon="refresh" label="Scan again" onClick={rescan} disabled={scanning} />
        {onClose && (
          <button type="button" className="dx-close" onClick={onClose} aria-label="Close explorer">
            ×
          </button>
        )}
      </div>

      {error && <p className="dx-error">{error}</p>}

      <table className="dx-table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="dx-bar-col" />
            <th>Size</th>
            <th>Share</th>
            <th>Files</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          {data?.parent != null && (
            <tr className="dx-row dx-row--up" onClick={() => setPath(data.parent)}>
              <td colSpan={6}>↑ ..</td>
            </tr>
          )}
          {entries.map((e) => {
            const openable = e.kind === "dir" || e.kind === "mount";
            const share = total && e.bytes ? (e.bytes / total) * 100 : null;
            return (
              <tr
                key={e.path}
                className={`dx-row dx-row--${e.kind} ${openable ? "dx-row--open" : ""}`}
                onClick={openable ? () => setPath(e.path) : undefined}
                title={
                  e.kind === "mount"
                    ? "A different filesystem — open it to scan it on its own"
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
              </tr>
            );
          })}
          {data?.more && (
            <tr className="dx-row">
              <td colSpan={6} className="dx-dim">
                + {data.more.count} smaller items ({formatBytes(data.more.bytes)})
              </td>
            </tr>
          )}
          {data?.state === "done" && entries.length === 0 && (
            <tr>
              <td colSpan={6} className="dx-dim">Empty.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export default DiskExplorer;
