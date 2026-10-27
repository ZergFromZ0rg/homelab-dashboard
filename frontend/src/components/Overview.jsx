import RebalancePanel from "./RebalancePanel";
import FirstRun from "./FirstRun";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import AddNode from "./AddNode";
import Timeline from "./Timeline";
import QuickActions from "./QuickActions";
import BusiestPanel from "./BusiestPanel";
import Panel from "./Panel";
import ServiceList from "./ServiceList";
import { useSettings } from "./settings";
import { isRootDown } from "./checkStatus";
import { issueTarget } from "./navTargets";

// What's wrong, always visible: one compact line per issue, worst first,
// each with a jump to where it lives. The longer "how to fix" notes sit
// behind a toggle so the list itself stays short. When nothing is wrong
// it's one quiet line.
function IssuesPanel({ overview, deployments, ready, onNavigate }) {
  const { ok, issues, recommendations, security } = overview;
  const unauthenticated = security && security.authenticated === false;
  const worst = issues.some((i) => i.severity === "bad") ? "bad" : "warn";

  return (
    <Panel
      title="Needs attention"
      count={ok ? null : issues.length}
      tone={!ready ? undefined : ok ? "ok" : worst}
      className="ov-issues"
    >
      {!ready ? (
        <p className="overview-empty">Waiting for the first update…</p>
      ) : ok ? (
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
                onClick={() => onNavigate(...issueTarget(issue.key))}
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

// The whole fleet on one screen: the headline numbers on one line, then three
// columns of panels — the servers (a click opens that server's pages), what is
// wrong and what is answering, and what is pinned and what happened. The lists
// scroll inside their panels; the page doesn't.
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
  ready = true,
  onControl,
  onNavigate,
  onOpenHost,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const hostCount = Object.keys(machines).length;
  const down = checks.filter(isRootDown).length;
  const firing = alerts.filter((a) => a.resolved_at == null).length;

  return (
    <div className="overview overview--dense ovb">
      <FirstRun machines={machines} backups={backups} onNavigate={onNavigate} />
      {homeCards.summary && (
        <SummaryRow
          overview={overview}
          machines={machines}
          containers={containers}
          backups={backups}
          ready={ready}
          agents
        />
      )}
      <div className="ovb-grid">
        <div className="ovw-col">
          {homeCards.hosts && (
            <Panel title="Servers" count={hostCount || null} className="ov-hosts-panel">
              <HostSummary machines={machines} containers={containers} ready={ready} onOpen={onOpenHost} />
            </Panel>
          )}
          {homeCards.hosts && <BusiestPanel containers={containers} onOpen={(name) => onNavigate("containers", { container: name })} />}
          {homeCards.hosts && <AddNode />}
        </div>
        <div className="ovw-col">
          {homeCards.attention && (
            <IssuesPanel overview={overview} deployments={deployments} ready={ready} onNavigate={onNavigate} />
          )}
          {homeCards.services && checks.length > 0 && (
            <Panel title="Uptime" count={down ? `${down} down` : checks.length} tone={down ? "bad" : undefined}>
              <ServiceList checks={checks} onOpen={(c) => onNavigate("network", { section: "checks", check: c.id })} />
            </Panel>
          )}
        </div>
        <div className="ovw-col">
          {homeCards.quickActions && (
            <Panel title="Pinned" count={pins.length || null} linkLabel="Containers" onLink={() => onNavigate("containers")}>
              <QuickActions pins={pins} containers={containers} machines={machines} onControl={onControl} />
            </Panel>
          )}
          {(homeCards.alerts || homeCards.activity) && (
            <Panel
              title="Timeline"
              count={firing ? `${firing} firing` : null}
              tone={firing ? "bad" : undefined}
              className="ov-scroll"
            >
              <Timeline alerts={homeCards.alerts ? alerts : []} activity={homeCards.activity ? activity : []} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

export default Overview;
