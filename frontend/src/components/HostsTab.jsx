import { useEffect } from "react";
import HostHistory from "./HostHistory";
import HostManage from "./HostManage";
import HostNetwork from "./HostNetwork";
import HostShellButton from "./HostShellButton";
import HostStorage from "./HostStorage";
import MachineCard from "./MachineCard";
import Overview from "./Overview";
import PacketCapture from "./PacketCapture";
import { Journal, Services } from "./HostSystem";
import PageLede from "./PageLede";
import { HOST_NAV, hostsSub, navEntry, parseHostsSub } from "./hostsNav";
import { purposeOf } from "./navPurpose";
import { hostColor } from "./hostColor";
import { useFitHeight } from "./useFitHeight";
import { useLocalStorage } from "./useLocalStorage";

// The machines, one page each. Pick the server once — or the fleet as a whole
// — and everything about it is a page in the same row: its health, disks and
// files, services, network, and the things you change. Each page says what it
// is for, and History and Packets are the second view of Health and Network.
// `sub` is the address's second half (`overview`, or `bigboy/storage`), so the
// browser's back and forward walk the pages too.
function HostsTab({ sub, onSub, machines, containers, history, mainHost, connected, filesTarget, onFilesTargetUsed, ...fleet }) {
  const fit = useFitHeight();
  const hosts = Object.keys(machines).sort();
  const [lastHost, setLastHost] = useLocalStorage("hostsLastHost", null);
  const { host, page } = parseHostsSub(sub, hosts, lastHost);
  const [entryId, , , views] = navEntry(page);
  // A bare page in the address ("storage") means the host you were last on.
  useEffect(() => {
    if (host && host !== lastHost) setLastHost(host);
  }, [host, lastHost, setLastHost]);

  const machine = host ? machines[host] : null;
  const facts = machine?.host_facts;
  const failed = facts?.failed_units?.length || 0;
  const pending = facts?.os_updates || 0;
  // A page's badge is what on it needs a look.
  const badges = {
    services: failed ? [failed, "bad"] : null,
    manage: facts?.reboot_required ? ["!", "warn"] : pending ? [pending, facts?.security_updates ? "warn" : null] : null,
  };

  return (
    <section className="hosts-tab fit-page" ref={fit} style={host ? { "--host-color": hostColor(host) } : undefined}>
      <div className="net-bar hosts-bar">
        <div className="net-hosts" role="tablist" aria-label="Server">
          <button
            type="button"
            role="tab"
            aria-selected={!host}
            className={`net-host-tab ${!host ? "active" : ""}`}
            onClick={() => onSub(hostsSub(null))}
          >
            Overview
          </button>
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={h === host}
              className={`net-host-tab ${h === host ? "active" : ""}`}
              style={{ "--host-color": hostColor(h) }}
              onClick={() => onSub(hostsSub(h, host ? page : "summary"))}
            >
              <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
              {h}
            </button>
          ))}
        </div>

        {host && (
          <div className="hsys-tabs" role="tablist" aria-label={`${host} pages`}>
            {HOST_NAV.map(([id, label]) => {
              const badge = badges[id];
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={entryId === id}
                  className={entryId === id ? "active" : ""}
                  title={purposeOf("hosts", { page: id, host })}
                  onClick={() => onSub(hostsSub(host, id))}
                >
                  {label}
                  {badge && <span className={`hsys-badge ${badge[1] ? `hsys-badge--${badge[1]}` : ""}`}>{badge[0]}</span>}
                </button>
              );
            })}
          </div>
        )}

        {host && (
          <span className="hosts-bar-end">
            <HostShellButton host={host} />
          </span>
        )}
      </div>

      <PageLede
        text={purposeOf("hosts", { page, host })}
        views={host ? views : null}
        current={page}
        onView={(id) => onSub(hostsSub(host, id))}
      />

      {!host && (
        <div className="fit-pane hosts-pane--board">
          <Overview machines={machines} containers={containers} {...fleet} onOpenHost={(h) => onSub(hostsSub(h))} />
        </div>
      )}

      {host && page === "summary" && (
        <div className="fit-pane hosts-pane--card">
          <div className="ovw-slide">
            <MachineCard
              key={host}
              name={host}
              machine={machine}
              history={history[host]}
              containers={containers[host]}
              main={host === mainHost}
              onOpenFolder={(path) => fleet.onNavigate("files", { host, path })}
              onOpenContainers={(container) => fleet.onNavigate("containers", container ? { container } : {})}
              onOpenServices={() => onSub(hostsSub(host, "services"))}
            />
          </div>
        </div>
      )}

      {host && page === "history" && (
        <div className="fit-pane">
          <HostHistory key={host} host={host} />
        </div>
      )}

      {host && page === "storage" && (
        <div className="fit-pane hosts-pane--fill">
          <HostStorage key={host} host={host} machine={machine} target={filesTarget} onTargetUsed={onFilesTargetUsed} />
        </div>
      )}

      {host && page === "services" && (
        <div className="fit-pane hosts-pane--fill">
          {machine.terminal ? (
            <div className="host-pair">
              <section className="overview-card">
                <div className="overview-card-head">
                  <h2>Services</h2>
                  {failed > 0 && <span className="overview-card-count">{failed} failed</span>}
                </div>
                <div className="host-pair-body">
                  <Services key={host} host={host} />
                </div>
              </section>
              <section className="overview-card">
                <div className="overview-card-head">
                  <h2>Journal</h2>
                </div>
                <div className="host-pair-body">
                  <Journal key={host} host={host} />
                </div>
              </section>
            </div>
          ) : (
            <p className="mb-empty">
              Host control is off on {host}'s agent — set <code>TERMINAL_ENABLED=1</code> in its <code>.env</code> to
              see its services and journal.
            </p>
          )}
        </div>
      )}

      {host && page === "network" && (
        <div className="fit-pane hosts-pane--fill">
          <HostNetwork key={host} host={host} machine={machine} containers={containers[host]} history={history[host]} />
        </div>
      )}

      {host && page === "packets" && (
        <div className="fit-pane hosts-pane--fill">
          <section className="overview-card net-fill">
            <PacketCapture key={host} host={host} />
          </section>
        </div>
      )}

      {host && page === "manage" && (
        <div className="fit-pane hosts-pane--fill">
          <HostManage host={host} machine={machine} />
        </div>
      )}

      {hosts.length === 0 && (
        <div className="empty-state">{connected === false ? "Connecting…" : "No servers reporting yet."}</div>
      )}
    </section>
  );
}

export default HostsTab;
