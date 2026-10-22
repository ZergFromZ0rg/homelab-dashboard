import BandwidthPanel from "./BandwidthPanel";
import LanScan from "./LanScan";
import NetworkOverview from "./NetworkOverview";
import NetworkWatch from "./NetworkWatch";
import PiholePanel from "./PiholePanel";
import UptimeScreen from "./UptimeScreen";
import { hostColor } from "./hostColor";
import { isRootDown } from "./checkStatus";
import { useLocalStorage } from "./useLocalStorage";
import PageLede from "./PageLede";
import { purposeOf } from "./navPurpose";
import { entryOf, networkSections, parseSection, pickSection, PER_HOST, SECTION_VIEWS } from "./networkSections";
import { useFitHeight } from "./useFitHeight";

// The network as a whole. It opens on the Overview — services, internet, DNS and
// the switch in one window — and the tools that need a screen of their own are
// pages beside it: the uptime checks, DNS and its devices, bandwidth, and a scan
// and a watch of the LAN from one server of your choice. One server's own traffic,
// ports and packets are on its page under Hosts. `section` and `onSection` are the
// address's second half (`dns`, or `checks/k5`), so back and forward walk them.
function NetworkTab({ machines, checks, connected, issues = [], ready = true, section: wanted, onSection }) {
  const fit = useFitHeight();
  const hosts = Object.keys(machines).sort();
  const [picked, setPicked] = useLocalStorage("networkHost", null);
  const host = hosts.includes(picked) ? picked : hosts[0];
  // The Uptime page's badge is what needs a look on it, never how many there are.
  const down = checks.filter(isRootDown).length;
  const slow = checks.filter((c) => c.status === "degraded").length;
  const checksBadge = down ? `${down} down` : slow ? `${slow} slow` : null;

  const sections = networkSections(checksBadge);
  const section = pickSection(sections, wanted);
  const perHost = PER_HOST.includes(section);
  const entry = entryOf(section);
  const { detail } = parseSection(wanted);

  return (
    <section className="network-tab fit-page" ref={fit}>
      <div className="net-bar">
        <div className="hsys-tabs" role="tablist" aria-label="Network">
          {sections.map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={entry === id}
              className={entry === id ? "active" : ""}
              title={purposeOf("network", { section: id })}
              onClick={() => onSection(id)}
            >
              {label}
              {badge != null && <span className={`hsys-badge ${down ? "hsys-badge--bad" : "hsys-badge--warn"}`}>{badge}</span>}
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

      {section !== "overview" && (
        <PageLede text={purposeOf("network", { section })} views={SECTION_VIEWS[entry]} current={section} onView={onSection} />
      )}

      {perHost && hosts.length === 0 && (
        <div className="empty-state">{connected === false ? "Connecting…" : "No servers reporting yet."}</div>
      )}

      {section === "overview" && (
        <div className="fit-pane">
          <NetworkOverview checks={checks} issues={issues} ready={ready} hosts={hosts} onSection={onSection} />
        </div>
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

      {section === "checks" && (
        <div className="fit-pane">
          <UptimeScreen
            key={detail}
            checks={checks}
            connected={connected}
            hosts={hosts.filter((h) => machines[h]?.agent_reachable != null)}
            initialId={detail}
          />
        </div>
      )}
    </section>
  );
}

export default NetworkTab;
