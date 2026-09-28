import DiskExplorer from "./DiskExplorer";
import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

// The file browser as a tab (Advanced / God): pick a server, jump to its
// home, / or any of its disks, and browse, preview, upload, download and
// delete like on the server card. `target` ({host, path, n}) opens a
// specific folder — how "Kept in …" on a backup lands here.
function FilesTab({ machines, connected, target, onTargetUsed }) {
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

  return (
    <section className="files-tab">
      <div className="system-bar">
        <div className="net-hosts" role="tablist" aria-label="Server">
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={h === host}
              className={`net-host-tab ${h === host ? "active" : ""}`}
              style={{ "--host-color": hostColor(h) }}
              onClick={() => go(h, "~")}
            >
              <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
              {h}
            </button>
          ))}
        </div>
        <div className="files-jumps">
          <button type="button" className="btn btn--sm" onClick={() => go(host, "~")}>Home</button>
          <button type="button" className="btn btn--sm" onClick={() => go(host, "/")}>/</button>
          {disks
            .filter((fs) => fs.mountpoint !== "/")
            .map((fs) => (
              <button
                key={fs.mountpoint}
                type="button"
                className="btn btn--sm"
                title={`${fs.mountpoint} (${fs.device})`}
                onClick={() => go(host, fs.mountpoint)}
              >
                {diskLabel(fs)}
              </button>
            ))}
        </div>
      </div>

      <DiskExplorer key={`${host}:${path}:${wanted?.n ?? ""}`} host={host} start={path} />
    </section>
  );
}

export default FilesTab;
