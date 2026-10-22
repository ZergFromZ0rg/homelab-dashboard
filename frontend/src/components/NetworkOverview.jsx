import "./network.css";
import { DnsPanel, InternetPanel, LinksPanel, PortsPanel, UptimePanel, UsagePanel } from "./NetworkPanels";
import { fetchBandwidth } from "./bandwidthApi";
import { fetchMatrix } from "./checksApi";
import { sectionAddress } from "./networkSections";
import { issueSection, summaryItems } from "./networkSummary";
import { fetchDevices, fetchPihole } from "./piholeApi";
import { fetchSpeedtest } from "./speedtestApi";
import { fetchSwitch } from "./switchApi";
import { usePolled } from "./usePolled";

const SHOWN = 6;

// What is wrong, one line each, the worst first; each one opens the page that
// explains it. Nothing at all when nothing is wrong.
function AttentionLine({ issues, onSection }) {
  return (
    <div className="nh-attn" role="list" aria-label="Needs attention">
      {issues.slice(0, SHOWN).map((issue) => {
        const { section, check } = issueSection(issue.key);
        return (
          <button
            key={issue.key}
            type="button"
            role="listitem"
            className={`ov-issue ov-issue--${issue.severity}`}
            title={issue.message}
            onClick={() => onSection(sectionAddress(section, check))}
          >
            <span className={`status-dot status-dot--${issue.severity}`} />
            <strong>{issue.title}</strong>
            <span className="ov-go" aria-hidden="true">→</span>
          </button>
        );
      })}
      {issues.length > SHOWN && <span className="nh-attn-more">+{issues.length - SHOWN} more</span>}
    </div>
  );
}

// The whole network in one window: the headline numbers on one line, what is
// wrong (only when something is), then three columns — the internet and who is
// using it, what is answering, DNS and the switch. Each panel polls its own
// source and says what it has; the tools with a screen of their own (Uptime, DNS,
// Bandwidth, LAN) are one click away from the panel that summarises them.
function NetworkOverview({ checks, issues, ready, hosts, onSection }) {
  const speed = usePolled(fetchSpeedtest, "speed", 15000);
  const bandwidth = usePolled(() => fetchBandwidth("2h"), "bandwidth", 15000);
  const pihole = usePolled(fetchPihole, "pihole", 15000);
  const devices = usePolled(fetchDevices, "devices", 30000);
  const sw = usePolled(fetchSwitch, "switch", 15000);
  const matrix = usePolled(fetchMatrix, "matrix", 15000);

  const items = summaryItems({ ready, issues, checks, speed: speed.data, pihole: pihole.data, sw: sw.data });
  const openCheck = (id) => onSection(sectionAddress("checks", id));

  return (
    <div className="overview overview--dense ovb net-home">
      <div className="stat-strip">
        {items.map((item) => (
          <span key={item.id} className={`stat-item ${item.tone ? `stat-item--${item.tone}` : ""}`} title={item.title}>
            <span className="stat-label">{item.label}</span>
            <strong>{item.value}</strong>
          </span>
        ))}
      </div>

      {issues.length > 0 && <AttentionLine issues={issues} onSection={onSection} />}

      <div className="ovb-grid">
        <div className="ovw-col">
          <InternetPanel speed={speed} bandwidth={bandwidth} onOpen={() => onSection("bandwidth")} />
          <UsagePanel bandwidth={bandwidth} hosts={hosts} onOpen={() => onSection("bandwidth")} />
        </div>
        <div className="ovw-col">
          <UptimePanel checks={checks} onOpenCheck={openCheck} onOpen={() => onSection("checks")} />
          <LinksPanel matrix={matrix} onOpenCheck={openCheck} />
        </div>
        <div className="ovw-col">
          <DnsPanel pihole={pihole} devices={devices} onOpen={() => onSection("dns")} />
          <PortsPanel sw={sw} hosts={hosts} />
        </div>
      </div>
    </div>
  );
}

export default NetworkOverview;
