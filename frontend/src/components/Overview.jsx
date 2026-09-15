import RebalancePanel from "./RebalancePanel";
import TodoList from "./TodoList";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import ActivityFeed from "./ActivityFeed";
import QuickActions from "./QuickActions";
import { useSettings } from "./settings";

// A titled panel. The Overview is a stack of these, so a future
// "project X" card is one more <OverviewCard> fed by its own data.
function OverviewCard({ title, count, children }) {
  return (
    <section className="overview-card">
      <div className="overview-card-head">
        <h2>{title}</h2>
        {count != null && <span className="overview-card-count">{count}</span>}
      </div>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

// issue key -> which tab to open for the details
function issueTab(key) {
  if (/:offline|:agent|:stale/.test(key)) return "system";
  if (key.startsWith("deploy:")) return "deploy";
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
  todos,
  openTodos,
  onControl,
  onSetTodos,
  onNavigate,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const anySide = homeCards.todo;

  return (
    <div className={`overview ${anySide ? "" : "overview--full"}`}>
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
          <OverviewCard title="Hosts">
            <HostSummary machines={machines} containers={containers} />
          </OverviewCard>
        )}

        {homeCards.quickActions && (
          <OverviewCard title="Quick actions">
            <QuickActions
              pins={pins}
              containers={containers}
              machines={machines}
              onControl={onControl}
              onNavigate={onNavigate}
            />
          </OverviewCard>
        )}

        {homeCards.activity && (
          <OverviewCard title="Recent activity">
            <ActivityFeed activity={activity} />
          </OverviewCard>
        )}
      </div>

      {anySide && (
        <aside className="overview-side">
          {homeCards.todo && (
            <OverviewCard title="To-do" count={openTodos || null}>
              <TodoList todos={todos} onChange={onSetTodos} compact />
            </OverviewCard>
          )}
        </aside>
      )}
    </div>
  );
}

export default Overview;
