import DiskExplorer from "./DiskExplorer";
import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";
import { useFitHeight } from "./useFitHeight";

// The file browser as a tab (Advanced / God): servers and their places (home
// and each disk, with how full it is) down the left, the folder on the right,
// and browse, preview, upload, download and delete like on the server card. `target` ({host, path, n}) opens a
// specific folder — how "Kept in …" on a backup lands here.
function FilesTab({ machines, connected, target, onTargetUsed }) {
  const fit = useFitHeight();
  const hosts = Object.keys(machines)
    .filter((h) => machines[h].agent_reachable)
    .sort();
  const [picked, setPicked] = useLocalStorage("filesHost", null);
  const [start, setStart] = useLocalStorage("filesStart", "~");

  const wanted = target && hosts.includes(target.host) ? target : null;
  const host = wanted?.host || (hosts.includes(picked) ? picked : hosts[0]);
  const path = wanted?.path || start;

  if (!host) {
    return (
      <div className="empty-state">
        {connected === false ? "Connecting…" : "No server with a reachable agent."}
      </div>
    );
  }

  const go = (h, p) => {
    onTargetUsed?.();
    setPicked(h);
    setStart(p);
  };
  const disks = [...(machines[host].filesystems || [])].sort((a, b) =>
    a.mountpoint.localeCompare(b.mountpoint)
  );
  const places = [
    { key: "~", label: "Home", path: "~" },
    ...disks.map((fs) => ({
      key: fs.mountpoint,
      label: fs.mountpoint === "/" ? "System /" : diskLabel(fs),
      path: fs.mountpoint,
      title: `${fs.mountpoint} (${fs.device})`,
      pct: fs.used_percent,
    })),
  ];
  const active = places.find((pl) => pl.path === path)?.key ?? null;

  return (
    <section className="files-tab" ref={fit}>
      <aside className="files-side">
        <div className="files-hosts" role="tablist" aria-label="Server">
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={h === host}
              className={`files-host ${h === host ? "active" : ""}`}
              style={{ "--host-color": hostColor(h) }}
              onClick={() => go(h, "~")}
            >
              <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
              {h}
            </button>
          ))}
        </div>

        <div className="files-places">
          <h3>Places</h3>
          {places.map((pl) => (
            <button
              key={pl.key}
              type="button"
              className={`files-place ${active === pl.key ? "active" : ""}`}
              title={pl.title}
              onClick={() => go(host, pl.path)}
            >
              <span className="files-place-name">{pl.label}</span>
              {pl.pct != null && (
                <>
                  <span className="files-place-pct">{Math.round(pl.pct)}%</span>
                  <span className={`files-place-bar ${pl.pct >= 90 ? "crit" : pl.pct >= 70 ? "warn" : ""}`}>
                    <span style={{ width: `${Math.min(100, pl.pct)}%` }} />
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </aside>

      <div className="files-main">
        <DiskExplorer key={`${host}:${path}:${wanted?.n ?? ""}`} host={host} start={path} />
      </div>
    </section>
  );
}

export default FilesTab;
