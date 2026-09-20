import RebalancePanel from "./RebalancePanel";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import Card from "./Card";
import ActivityFeed from "./ActivityFeed";
import QuickActions from "./QuickActions";
import { useSettings } from "./settings";

// issue key -> which tab to open for the details: host-level problems
// (offline, disk, temperature, backup...) live on Servers, container ones
// on Containers.
function issueTab(key) {
  if (key.startsWith("deploy:")) return "deploy";
  if (key.startsWith("container:")) return "containers";
  if (key.startsWith("host:")) return "servers";
  return "containers";
}

function AttentionPanel({ overview, deployments, onNavigate }) {
  const { ok, issues, recommendations } = overview;

  return (
    <section className="overview-card attention">
      <div className="overview-card-head">
        <h2>Attention</h2>
        {!ok && <span className="overview-card-count">{issues.length}</span>}
      </div>
      <div className="overview-card-body">
        {ok ? (
          <p className="attention-clear">
            <span className="status-dot status-dot--ok" />
            No issues detected
          </p>
        ) : (
          <>
            <ul className="attention-issues">
              {issues.map((issue) => (
                <li key={issue.key} className="attention-issue">
                  <span className={`status-dot status-dot--${issue.severity}`} />
                  <span className="attention-issue-text">
                    <strong>{issue.title}</strong>
                    <span>{issue.message}</span>
                  </span>
                  <button
                    type="button"
                    className="attention-view"
                    onClick={() => onNavigate(issueTab(issue.key))}
                  >
                    View
                  </button>
                </li>
              ))}
            </ul>

            {recommendations.length > 0 && (
              <ul className="recommendation-list">
                {recommendations.map((rec) => (
                  <li key={rec}>{rec}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <RebalancePanel deployments={deployments} />
      </div>
    </section>
  );
}

function Overview({
  overview,
  machines,
  containers,
  deployments,
  activity,
  pins,
  onControl,
  onNavigate,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const hostCount = Object.keys(machines).length;
  const showRail = homeCards.quickActions || homeCards.activity;

  return (
    <div className={`overview ${showRail ? "" : "overview--full"}`}>
      <div className="overview-main">
        {homeCards.summary && (
          <SummaryRow
            overview={overview}
            machines={machines}
            containers={containers}
          />
        )}

        {homeCards.attention && (
          <AttentionPanel
            overview={overview}
            deployments={deployments}
            onNavigate={onNavigate}
          />
        )}

        {homeCards.hosts && (
          <section className="overview-section">
            <div className="overview-section-head">
              <h2>Servers</h2>
              <span className="overview-card-count">{hostCount}</span>
              <button
                type="button"
                className="btn btn--sm btn--ghost overview-section-link"
                onClick={() => onNavigate("servers")}
              >
                All details →
              </button>
            </div>
            <HostSummary
              machines={machines}
              containers={containers}
              onOpen={() => onNavigate("servers")}
            />
          </section>
        )}
      </div>

      {showRail && (
        <aside className="overview-side">
          {homeCards.quickActions && (
            <Card title="Quick actions">
              <QuickActions
                pins={pins}
                containers={containers}
                machines={machines}
                onControl={onControl}
                onNavigate={onNavigate}
              />
            </Card>
          )}

          {homeCards.activity && (
            <Card title="Recent activity">
              <ActivityFeed activity={activity} />
            </Card>
          )}
        </aside>
      )}
    </div>
  );
}

export default Overview;
