import { useLayoutEffect, useRef } from "react";
import { useSectionRequest } from "./focusRequest";
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
import { isRootDown } from "./checkStatus";

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
  const order = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
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
          title={
            c.status === "down"
              ? `${c.name} is down — ${c.suppressed_by ? `behind ${c.suppressed_by.name}` : c.detail ?? ""}`
              : c.status === "degraded"
                ? `${c.name} is slow — over ${formatLatency(c.slow_ms)}`
                : c.target
          }
        >
          <span
            className={`status-dot status-dot--${
              c.status === "up" ? "ok" : c.status === "down" ? "bad" : c.status === "degraded" ? "warn" : "none"
            }`}
          />
          <AppIcon url={c.target} label={c.name} className="app-tile-icon ov-icon" />
          <span className="ov-service-name">{c.name}</span>
          <span className="ov-service-ms">
            {c.status === "down"
              ? "down"
              : c.status === "up" || c.status === "degraded"
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

// One page for the fleet. Advanced / God (`detail`): the headline numbers
// on one line, four panels side by side (what's wrong, services, pinned,
// the timeline), then every server's full vitals, each foldable to a line
// — Servers used to be its own tab. Simple: the headline numbers live in
// the page header instead, the servers are one panel of columns (one per
// host, like the briefing above it), then what's wrong / services / the
// timeline, and pinned containers only once something is pinned.
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
  ready = true,
  detail = false,
  onControl,
  onNavigate,
}) {
  const {
    settings: { homeCards },
  } = useSettings();

  const hostCount = Object.keys(machines).length;
  const down = checks.filter(isRootDown).length;
  const firing = alerts.filter((a) => a.resolved_at == null).length;

  // Simple keeps healthy things quiet: with nothing wrong (and no login
  // footnote to show) the header's "all clear" says it, not an empty panel.
  const quiet =
    !detail && ready && overview.ok && overview.security?.authenticated !== false;
  const issues = homeCards.attention && !quiet && (
    <IssuesPanel overview={overview} deployments={deployments} ready={ready} onNavigate={onNavigate} />
  );
  const services = homeCards.services && checks.length > 0 && (
    <Panel
      title="Services"
      count={down ? `${down} down` : checks.length}
      tone={down ? "bad" : undefined}
    >
      <ServiceList checks={checks} onOpen={() => onNavigate("network")} />
    </Panel>
  );
  const pinned = homeCards.quickActions && (detail || pins.length > 0) && (
    <Panel
      title="Pinned"
      count={pins.length || null}
      linkLabel="Containers"
      onLink={() => onNavigate("containers")}
      className={detail ? "" : "ov-pinned-wide"}
    >
      <QuickActions pins={pins} containers={containers} machines={machines} onControl={onControl} />
    </Panel>
  );
  const timeline = (homeCards.alerts || homeCards.activity) && (
    <Panel
      title="Timeline"
      count={firing ? `${firing} firing` : null}
      tone={firing ? "bad" : undefined}
      className="ov-scroll"
    >
      <Timeline
        alerts={homeCards.alerts ? alerts : []}
        activity={homeCards.activity ? activity : []}
      />
    </Panel>
  );

  if (!detail) {
    return (
      <div className="overview overview--dense overview--simple">
        <FirstRun machines={machines} backups={backups} onNavigate={onNavigate} />

        {homeCards.hosts && (
          <Panel
            title="Servers"
            count={hostCount || null}
            linkLabel="Details"
            onLink={() => onNavigate("servers")}
            className="ov-hosts-panel"
          >
            <HostSummary
              machines={machines}
              containers={containers}
              ready={ready}
              onOpen={(host) => onNavigate("servers", { host })}
            />
          </Panel>
        )}

        {(issues || services || timeline) && (
          <div className="ov-grid ov-grid--simple">
            {issues}
            {services}
            {timeline}
          </div>
        )}

        {pinned}
      </div>
    );
  }

  return (
    <DetailWindows>
      <section className="ovw-win">
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
        {homeCards.hosts ? (
          <HostGrid machines={machines} containers={containers} history={history} mainHost={mainHost} />
        ) : (
          <p className="overview-empty">Server cards are switched off in Settings.</p>
        )}
      </section>

      <section className="ovw-win ovw-win--panels" data-section="panels">
        <div className="ovw-col">
          {issues}
          {services}
          {homeCards.hosts && <AddNode />}
        </div>
        <div className="ovw-col">
          {pinned}
          {timeline}
        </div>
      </section>
    </DetailWindows>
  );
}

// Advanced / God Overview as two screens that snap into place as you scroll:
// the servers first (swipe sideways for more of them), then the panels that
// answer "what's wrong, what's running, what happened". Each screen is as
// tall as the window, so the lists inside scroll rather than the page.
function DetailWindows({ children }) {
  const root = useRef(null);
  // A link from Simple ("See all" under Live updates) lands on the second
  // screen, where the Timeline is.
  useSectionRequest((name) => {
    if (name !== "timeline") return;
    setTimeout(() => root.current?.querySelector('[data-section="panels"]')?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  });
  useLayoutEffect(() => {
    const html = document.documentElement;
    const measure = () => {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().height || 56;
      html.style.setProperty("--ov-top", `${top}px`);
      root.current?.style.setProperty("--ov-h", `${Math.max(460, window.innerHeight - top - 32)}px`);
    };
    measure();
    html.classList.add("ov-snap");
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      html.classList.remove("ov-snap");
      html.style.removeProperty("--ov-top");
    };
  }, []);
  return (
    <div className="overview overview--dense ovw" ref={root}>
      {children}
    </div>
  );
}

export default Overview;
