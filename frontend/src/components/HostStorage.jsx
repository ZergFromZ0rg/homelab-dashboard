import DiskExplorer from "./DiskExplorer";
import DiskHealth from "./DiskHealth";
import { diskLabel } from "./diskLabel";
import { formatDaysUntilFull } from "./format";
import { useLocalStorage } from "./useLocalStorage";

// One server's storage: its places down the left (home, and every disk with
// how full it is and when it will be), the drives' own health under them, and
// the folder you are in on the right, with browse, preview, upload, download
// and delete. `target` ({host, path, n}) opens a specific folder — how "Kept
// in …" on a backup lands here.
function HostStorage({ host, machine, target, onTargetUsed }) {
  const [start, setStart] = useLocalStorage("filesStart", "~");
  const wanted = target && target.host === host ? target : null;
  const path = wanted?.path || start;

  if (!machine.agent_reachable) {
    return <div className="empty-state">{host}'s agent isn't reachable, so its files can't be listed.</div>;
  }

  const go = (p) => {
    onTargetUsed?.();
    setStart(p);
  };
  const disks = [...(machine.filesystems || [])].sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
  const places = [
    { key: "~", label: "Home", path: "~" },
    ...disks.map((fs) => ({
      key: fs.mountpoint,
      label: fs.mountpoint === "/" ? "System /" : diskLabel(fs),
      path: fs.mountpoint,
      title: [`${fs.mountpoint} (${fs.device})`, fs.days_until_full != null && `full in ${formatDaysUntilFull(fs.days_until_full)}`]
        .filter(Boolean)
        .join(" — "),
      pct: fs.used_percent,
    })),
  ];
  const active = places.find((pl) => pl.path === path)?.key ?? null;

  return (
    <section className="files-tab hosts-storage">
      <aside className="files-side">
        <div className="files-places">
          <h3>Places</h3>
          {places.map((pl) => (
            <button
              key={pl.key}
              type="button"
              className={`files-place ${active === pl.key ? "active" : ""}`}
              title={pl.title}
              onClick={() => go(pl.path)}
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

        {machine.disk_health && (
          <div className="files-places">
            <h3>Drive health</h3>
            <DiskHealth health={machine.disk_health} list />
          </div>
        )}
      </aside>

      <div className="files-main">
        <DiskExplorer key={`${host}:${path}:${wanted?.n ?? ""}`} host={host} start={path} />
      </div>
    </section>
  );
}

export default HostStorage;
