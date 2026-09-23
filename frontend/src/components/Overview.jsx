import RebalancePanel from "./RebalancePanel";
import SummaryRow from "./SummaryRow";
import HostSummary from "./HostSummary";
import Card from "./Card";
import { formatLatency } from "./format";
import ActivityFeed from "./ActivityFeed";
import AlertHistory from "./AlertHistory";
import QuickActions from "./QuickActions";
import { useSettings } from "./settings";
import AppIcon from "./AppIcon";
import { useState } from "react";

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

// Issues as one banner across the top: the count and the first few titles
// while collapsed, the full list (with the suggested fixes) when opened.
// Collapsed by default so the front page is the board, not a wall of text;
// when nothing is wrong it's a single quiet "all clear" line.
function IssuesBanner({ overview, deployments, onNavigate }) {
  const { ok, issues, recommendations, security } = overview;
  const [open, setOpen] = useState(false);
  const worst = issues.some((i) => i.severity === "bad") ? "bad" : "warn";
  const unauthenticated = security && security.authenticated === false;

  return (
    <section
      className={`issues-banner ${ok ? "issues-banner--ok" : `issues-banner--${worst}`} ${
        open ? "issues-banner--open" : ""
      }`}
    >
      {ok ? (
        <div className="issues-banner-bar">
          <span className="status-dot status-dot--ok" />
          <strong>All clear</strong>
          <span className="issues-banner-sub">no issues detected</span>
        </div>
      ) : (
        <button
          type="button"
          className="issues-banner-bar"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={`status-dot status-dot--${worst}`} />
          <strong>
            {issues.length} issue{issues.length === 1 ? "" : "s"} need
            {issues.length === 1 ? "s" : ""} attention
          </strong>
          {!open && (
            <span className="issues-banner-peek">
              {issues.slice(0, 3).map((i) => (
                <span key={i.key} className={`issue-pill issue-pill--${i.severity}`}>
                  {i.title}
                </span>
              ))}
              {issues.length > 3 && (
                <span className="issues-banner-more">+{issues.length - 3} more</span>
              )}
            </span>
          )}
          <span className="issues-banner-toggle">{open ? "Hide" : "Show all"}</span>
        </button>
      )}

      {open && !ok && (
        <div className="issues-banner-body">
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
        </div>
      )}

      {/* The auth mark. A footnote rather than an issue: being
          unauthenticated is a posture somebody chose, not an incident,
          and an issue that can never be cleared would mean this panel is
          never clean. It stays visible so the choice stays visible. */}
      {unauthenticated && (
        <details className="attention-posture">
          <summary>
            <span className="status-dot status-dot--warn" />
            Unauthenticated — anyone who can reach this dashboard can change
            your hosts
          </summary>
          <p>{security.message}</p>
          <p className="settings-hint">{security.hint}</p>
        </details>
      )}

      <RebalancePanel deployments={deployments} />
    </section>
  );
}

// A tile per Services check: the service's icon, name, and latency (or
// "down"). Anything down sorts first; a click opens the Services tab.
function ServiceTiles({ checks, onOpen }) {
  const order = { down: 0, pending: 1, up: 2, paused: 3 };
  const sorted = [...checks].sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name)
  );

  return (
    <div className="service-tiles">
      {sorted.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`service-tile service-tile--${c.status}`}
          onClick={onOpen}
          title={c.status === "down" ? `${c.name} is down — ${c.detail ?? ""}` : c.target}
        >
          <AppIcon url={c.target} label={c.name} />
          <span className="service-tile-name">{c.name}</span>
          <span className="service-tile-state">
            <span
              className={`status-dot status-dot--${
                c.status === "up" ? "ok" : c.status === "down" ? "bad" : "none"
              }`}
            />
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

function Section({ title, count, linkLabel, onLink, children }) {
  return (
    <section className="overview-section">
      <div className="overview-section-head">
        <h2>{title}</h2>
        {count != null && <span className="overview-card-count">{count}</span>}
        {onLink && (
          <button
            type="button"
            className="btn btn--sm btn--ghost overview-section-link"
            onClick={onLink}
          >
            {linkLabel} →
          </button>
        )}
      </div>
      {children}
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
  const showTimeline = homeCards.alerts || homeCards.activity;

  // One column of full-width sections, each an even grid of same-size
  // tiles: issues, headline numbers, servers, services, pinned containers,
  // then alert history and activity side by side.
  return (
    <div className="overview overview--board">
      {homeCards.attention && (
        <IssuesBanner
          overview={overview}
          deployments={deployments}
          onNavigate={onNavigate}
        />
      )}

      {homeCards.summary && (
        <SummaryRow
          overview={overview}
          machines={machines}
          containers={containers}
          backups={backups}
        />
      )}

      {homeCards.hosts && (
        <Section
          title="Servers"
          count={hostCount}
          linkLabel="All details"
          onLink={() => onNavigate("servers")}
        >
          <HostSummary
            machines={machines}
            containers={containers}
            onOpen={() => onNavigate("servers")}
          />
        </Section>
      )}

      {homeCards.services && checks.length > 0 && (
        <Section
          title="Services"
          count={checks.length}
          linkLabel="All checks"
          onLink={() => onNavigate("services")}
        >
          <ServiceTiles checks={checks} onOpen={() => onNavigate("services")} />
        </Section>
      )}

      {homeCards.quickActions && (
        <Section
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
        </Section>
      )}

      {showTimeline && (
        <div className={`overview-timeline ${homeCards.alerts && homeCards.activity ? "" : "overview-timeline--single"}`}>
          {homeCards.alerts && (
            <Card
              title="Alert history"
              count={alerts.filter((a) => a.resolved_at == null).length || null}
            >
              <AlertHistory alerts={alerts} />
            </Card>
          )}

          {homeCards.activity && (
            <Card title="Recent activity">
              <ActivityFeed activity={activity} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export default Overview;
