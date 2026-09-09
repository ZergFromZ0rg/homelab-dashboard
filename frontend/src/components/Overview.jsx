import RebalancePanel from "./RebalancePanel";
import TodoList from "./TodoList";

// A titled panel. The Overview is just a stack of these, so a future
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

function StatusPanel({ overview }) {
  const { ok, issues } = overview;

  if (ok) {
    return (
      <p className="status-ok">
        <span className="status-dot status-dot--ok" />
        All systems operational
      </p>
    );
  }

  return (
    <ul className="status-issues">
      {issues.map((issue) => (
        <li key={issue.key} className="status-issue">
          <span className={`status-dot status-dot--${issue.severity}`} />
          <span className="status-issue-text">
            <strong>{issue.title}</strong>
            <span>{issue.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Overview({ overview, todos, openTodos, deployments, onSetTodos }) {
  const recs = overview.recommendations ?? [];

  return (
    <div className="overview">
      <OverviewCard
        title="Status"
        count={overview.ok ? null : overview.issues.length}
      >
        <StatusPanel overview={overview} />
      </OverviewCard>

      <OverviewCard title="Recommendations">
        {recs.length === 0 ? (
          <p className="overview-empty">Nothing needs attention.</p>
        ) : (
          <ul className="recommendation-list">
            {recs.map((rec) => (
              <li key={rec}>{rec}</li>
            ))}
          </ul>
        )}
        <RebalancePanel deployments={deployments} />
      </OverviewCard>

      <OverviewCard title="To-do" count={openTodos || null}>
        <TodoList todos={todos} onChange={onSetTodos} />
      </OverviewCard>
    </div>
  );
}

export default Overview;
