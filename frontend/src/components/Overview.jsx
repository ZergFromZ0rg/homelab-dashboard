import RebalancePanel from "./RebalancePanel";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import { formatLatency } from "./format";
import ActivityFeed from "./ActivityFeed";
import AlertHistory from "./AlertHistory";
import QuickActions from "./QuickActions";
import { useSettings } from "./settings";
import AppIcon from "./AppIcon";

// issue key -> which tab to open for the details: host-level problems
// (offline, disk, temperature, backup...) live on Servers, container ones
// on Containers.
function issueTab(key) {
  if (key.startsWith("deploy:")) return "deploy";
  if (key.startsWith("check:")) return "services";
  if (key.startsWith("container:")) return "containers";
  if (key.startsWith("host:")) return "servers";
  return "containers";
}

// What's wrong, always visible: one compact line per issue, worst first,
// each with a jump to where it lives. The longer "how to fix" notes sit
// behind a toggle so the list itself stays short. When nothing is wrong
// it's one quiet line.
function IssuesPanel({ overview, deployments, onNavigate }) {
  const { ok, issues, recommendations, security } = overview;
  const unauthenticated = security && security.authenticated === false;
  const worst = issues.some((i) => i.severity === "bad") ? "bad" : "warn";

  return (
    <Panel
      title="Needs attention"
      count={ok ? null : issues.length}
      tone={ok ? "ok" : worst}
      className="ov-issues"
    >
      {ok ? (
        <p className="ov-clear">
          <span className="status-dot status-dot--ok" />
          All clear
        </p>
      ) : (
        <ul className="ov-issue-list">
          {issues.map((issue) => (
            <li key={issue.key}>
              <button
                type="button"
                className={`ov-issue ov-issue--${issue.severity}`}
                onClick={() => onNavigate(issueTab(issue.key))}
                title={issue.message}
              >
                <span className={`status-dot status-dot--${issue.severity}`} />
                <strong>{issue.title}</strong>
                <span className="ov-go" aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!ok && recommendations.length > 0 && (
        <details className="ov-fixes">
          <summary>How to fix ({recommendations.length})</summary>
          <ul className="recommendation-list">
            {recommendations.map((rec) => (
              <li key={rec}>{rec}</li>
            ))}
          </ul>
        </details>
      )}

      {/* The auth mark. A footnote rather than an issue: being
          unauthenticated is a posture somebody chose, not an incident,
          and an issue that can never be cleared would mean this panel is
          never clean. It stays visible so the choice stays visible. */}
      {unauthenticated && (
        <details className="attention-posture">
          <summary>
            <span className="status-dot status-dot--warn" />
            No login — anyone on the network can control your hosts
          </summary>
          <p>{security.message}</p>
          <p className="settings-hint">{security.hint}</p>
        </details>
      )}

      <RebalancePanel deployments={deployments} />
    </Panel>
  );
}

// Service health as a dense two-column list: dot, icon, name, latency.
// Down sorts first and is the only thing in color.
function ServiceList({ checks, onOpen }) {
  const order = { down: 0, pending: 1, up: 2, paused: 3 };
  const sorted = [...checks].sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name)
  );

  return (
    <div className="ov-services">
      {sorted.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`ov-service ov-service--${c.status}`}
          onClick={onOpen}
          title={c.status === "down" ? `${c.name} is down — ${c.detail ?? ""}` : c.target}
        >
          <span
            className={`status-dot status-dot--${
              c.status === "up" ? "ok" : c.status === "down" ? "bad" : "none"
            }`}
          />
          <AppIcon url={c.target} label={c.name} className="app-tile-icon ov-icon" />
          <span className="ov-service-name">{c.name}</span>
          <span className="ov-service-ms">
            {c.status === "down"
              ? "down"
              : c.status === "up"
                ? formatLatency(c.latency_ms)
                : c.status}
          </span>
        </button>
      ))}
    </div>
  );
}

// A titled panel with an optional "go to tab" link in its header. `tone`
// tints the header when the panel is reporting a problem.
function Panel({ title, count, tone, linkLabel, onLink, className = "", children }) {
  return (
    <section className={`overview-card ov-panel ${tone ? `ov-panel--${tone}` : ""} ${className}`}>
      <div className="overview-card-head">
        <h2>{title}</h2>
        {count != null && <span className="overview-card-count">{count}</span>}
        {onLink && (
          <button type="button" className="ov-panel-link" onClick={onLink}>
            {linkLabel} →
          </button>
        )}
      </div>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

function Overview({
  backups,
  overview,
  machines,
  containers,
  checks,
  deployments,
  activity,
  alerts,
  pins,
  onControl,
  onNavigate,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const hostCount = Object.keys(machines).length;
  const down = checks.filter((c) => c.status === "down").length;
  const firing = alerts.filter((a) => a.resolved_at == null).length;

  // Headline numbers, then a two-column grid of compact panels. Panels
  // sit in rows, so the two columns always line up.
  return (
    <div className="overview overview--dense">
      {homeCards.summary && (
        <SummaryRow
          overview={overview}
          machines={machines}
          containers={containers}
          backups={backups}
        />
      )}

      <div className="ov-grid">
        {homeCards.attention && (
          <IssuesPanel
            overview={overview}
            deployments={deployments}
            onNavigate={onNavigate}
          />
        )}

        {homeCards.hosts && (
          <Panel
            title="Servers"
            count={hostCount}
            linkLabel="Details"
            onLink={() => onNavigate("servers")}
          >
            <HostSummary
              machines={machines}
              containers={containers}
              onOpen={() => onNavigate("servers")}
            />
          </Panel>
        )}

        {homeCards.services && checks.length > 0 && (
          <Panel
            title="Services"
            count={down ? `${down} down` : checks.length}
            tone={down ? "bad" : undefined}
            linkLabel="All checks"
            onLink={() => onNavigate("services")}
          >
            <ServiceList checks={checks} onOpen={() => onNavigate("services")} />
          </Panel>
        )}

        {homeCards.quickActions && (
          <Panel
            title="Pinned"
            count={pins.length || null}
            linkLabel="Containers"
            onLink={() => onNavigate("containers")}
          >
            <QuickActions
              pins={pins}
              containers={containers}
              machines={machines}
              onControl={onControl}
            />
          </Panel>
        )}

        {homeCards.alerts && (
          <Panel title="Alert history" count={firing || null} className="ov-scroll">
            <AlertHistory alerts={alerts} />
          </Panel>
        )}

        {homeCards.activity && (
          <Panel title="Recent activity" className="ov-scroll">
            <ActivityFeed activity={activity} />
          </Panel>
        )}
      </div>
    </div>
  );
}

export default Overview;
