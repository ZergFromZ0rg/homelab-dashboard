import BandwidthPanel from "./BandwidthPanel";
import LanScan from "./LanScan";
import NetworkWatch from "./NetworkWatch";
import PiholePanel from "./PiholePanel";
import SwitchPanel from "./SwitchPanel";
import ServicesTab from "./ServicesTab";
import { hostColor } from "./hostColor";
import { isRootDown } from "./checkStatus";
import { useLocalStorage } from "./useLocalStorage";
import { networkSections, pickSection, PER_HOST } from "./networkSections";
import { useFitHeight } from "./useFitHeight";

// The network as a whole: uptime checks, DNS, bandwidth, the switch, and a
// scan and a watch of the LAN from one server of your choice. One server's own
// traffic, ports and packets are on its page under Hosts. `section` and
// `onSection` are the address's second half, so back and forward walk them.
function NetworkTab({ machines, checks, connected, section: wanted, onSection }) {
  const fit = useFitHeight();
  const hosts = Object.keys(machines).sort();
  const [picked, setPicked] = useLocalStorage("networkHost", null);
  const host = hosts.includes(picked) ? picked : hosts[0];
  const down = checks.filter(isRootDown).length;
  const checksBadge = down ? `${down} down` : checks.length || null;

  const sections = networkSections(checksBadge);
  const section = pickSection(sections, wanted);
  const perHost = PER_HOST.includes(section);

  return (
    <section className="network-tab fit-page" ref={fit}>
      <div className="net-bar">
        <div className="hsys-tabs" role="tablist" aria-label="Network">
          {sections.map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={section === id ? "active" : ""}
              onClick={() => onSection(id)}
            >
              {label}
              {badge != null && <span className={`hsys-badge ${id === "checks" && down ? "hsys-badge--bad" : ""}`}>{badge}</span>}
            </button>
          ))}
        </div>

        {perHost && hosts.length > 0 && (
          <div className="net-hosts net-hosts--bar" role="tablist" aria-label="Look from">
            {hosts.map((h) => (
              <button
                key={h}
                type="button"
                role="tab"
                aria-selected={h === host}
                className={`net-host-tab ${h === host ? "active" : ""}`}
                style={{ "--host-color": hostColor(h) }}
                onClick={() => setPicked(h)}
              >
                <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      {perHost && hosts.length === 0 && (
        <div className="empty-state">{connected === false ? "Connecting…" : "No servers reporting yet."}</div>
      )}

      {section === "scan" && host && (
        <div className="fit-pane">
          <section className="overview-card net-fill">
            <LanScan key={host} host={host} />
          </section>
        </div>
      )}

      {section === "watch" && host && (
        <div className="fit-pane">
          <section className="overview-card net-fill">
            <NetworkWatch key={host} host={host} />
          </section>
        </div>
      )}

      {section === "dns" && (
        <div className="fit-pane">
          <section className="overview-card net-fill">
            <PiholePanel />
          </section>
        </div>
      )}

      {section === "bandwidth" && (
        <div className="fit-pane">
          <section className="overview-card net-fill">
            <BandwidthPanel />
          </section>
        </div>
      )}

      {section === "switch" && (
        <div className="fit-pane">
          <section className="overview-card net-fill">
            <SwitchPanel />
          </section>
        </div>
      )}

      {section === "checks" && (
        <div className="net-checks fit-pane">
          <ServicesTab
            checks={checks}
            connected={connected}
            hosts={hosts.filter((h) => machines[h]?.agent_reachable != null)}
          />
        </div>
      )}
    </section>
  );
}

export default NetworkTab;
