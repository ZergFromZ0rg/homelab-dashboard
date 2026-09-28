import RebalancePanel from "./RebalancePanel";
import FirstRun from "./FirstRun";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import HostGrid from "./HostGrid";
import AddNode from "./AddNode";
import { formatLatency } from "./format";
import Timeline from "./Timeline";
import QuickActions from "./QuickActions";
import { useSettings } from "./settings";
import AppIcon from "./AppIcon";

// issue key -> where the details live: host problems on this page's
// server cards, checks on Network, container ones on Containers.
function issueTab(key) {
  if (key.startsWith("check:")) return "network";
  if (key.startsWith("container:")) return "containers";
  if (key.startsWith("host:") || key.startsWith("deploy:")) return "servers";
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

// One page for the fleet. On top the headline numbers on a single line,
// then four panels side by side (what's wrong, services, pinned, the
// timeline); with `detail` (Advanced / God) every server's full vitals
// follow, each foldable to a line — Servers used to be its own tab. Without
// it (Simple) a one-line-per-host Servers panel stands in.
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
  history = {},
  mainHost = null,
  detail = false,
  onControl,
  onNavigate,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const hostCount = Object.keys(machines).length;
  const down = checks.filter((c) => c.status === "down").length;
  const firing = alerts.filter((a) => a.resolved_at == null).length;

  return (
    <div className="overview overview--dense">
      <FirstRun machines={machines} backups={backups} onNavigate={onNavigate} />

      {homeCards.summary && (
        <SummaryRow
          overview={overview}
          machines={machines}
          containers={containers}
          backups={backups}
          agents={detail}
        />
      )}

      <div className="ov-grid">
        {!detail && homeCards.hosts && (
          <Panel title="Servers" count={hostCount}>
            <HostSummary
              machines={machines}
              containers={containers}
              onOpen={(host) => onNavigate("servers", { host })}
            />
          </Panel>
        )}

        {homeCards.attention && (
          <IssuesPanel
            overview={overview}
            deployments={deployments}
            onNavigate={onNavigate}
          />
        )}

        {homeCards.services && checks.length > 0 && (
          <Panel
            title="Services"
            count={down ? `${down} down` : checks.length}
            tone={down ? "bad" : undefined}
          >
            <ServiceList checks={checks} onOpen={() => onNavigate("network")} />
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

        {(homeCards.alerts || homeCards.activity) && (
          <Panel title="Timeline" count={firing ? `${firing} firing` : null} tone={firing ? "bad" : undefined} className="ov-scroll">
            <Timeline
              alerts={homeCards.alerts ? alerts : []}
              activity={homeCards.activity ? activity : []}
            />
          </Panel>
        )}
      </div>

      {detail && homeCards.hosts && (
        <>
          <HostGrid
            machines={machines}
            containers={containers}
            history={history}
            mainHost={mainHost}
          />
          <AddNode />
        </>
      )}
    </div>
  );
}

export default Overview;
