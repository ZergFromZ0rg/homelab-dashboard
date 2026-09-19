import { useMemo } from "react";
import ContainerRow from "./ContainerRow";
import ContainerTableHead from "./ContainerTableHead";
import SortControl from "./SortControl";
import { sortContainers, needsAttention } from "./containerSort";
import { pinKey, togglePin } from "./containerPins";
import { useLocalStorage } from "./useLocalStorage";
import { hostColor } from "./hostColor";
import { useSettings } from "./settings";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "attention", label: "Needs attention" },
  { value: "stopped", label: "Stopped" },
];

// Attention rows (unhealthy / restart-looping) float to the top of a host
// group, ahead of the chosen sort.
function orderContainers(list, sortBy, restartThreshold) {
  const sorted = sortContainers(list, sortBy);
  return [...sorted].sort(
    (a, b) =>
      (needsAttention(a, restartThreshold) ? 0 : 1) -
      (needsAttention(b, restartThreshold) ? 0 : 1)
  );
}

function matchesQuery(container, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    container.name.toLowerCase().includes(needle) ||
    (container.image || "").toLowerCase().includes(needle)
  );
}

function matchesStatus(container, filter, restartThreshold) {
  switch (filter) {
    case "running":
      return container.status === "running";
    case "stopped":
      return container.status !== "running";
    case "attention":
      return needsAttention(container, restartThreshold);
    default:
      return true;
  }
}

function HostGroup({
  host,
  containers,
  hostCores,
  agentReachable,
  staleAge,
  onControl,
  onTogglePin,
  collapsed,
  sortBy,
  onHostState,
  restartThreshold,
}) {
  const ordered = orderContainers(containers, sortBy, restartThreshold);

  const runningCount = containers.filter((c) => c.status === "running").length;
  const unhealthyCount = containers.filter((c) => c.health === "unhealthy").length;
  const stoppedCount = containers.length - runningCount;
  const unreachable = agentReachable === false && containers.length === 0;

  return (
    <div className="host-group" style={{ "--host-color": hostColor(host) }}>
      <div className={`host-header ${collapsed ? "" : "expanded"}`}>
        <button
          type="button"
          className="host-toggle-btn"
          onClick={() => onHostState({ collapsed: !collapsed })}
          aria-expanded={!collapsed}
        >
          <span className="host-toggle">▾</span>
          <span className="host-name">{host}</span>
          {unreachable ? (
            <span className="host-issue host-issue--bad">agent unreachable</span>
          ) : (
            <>
              <span
                className={`host-running-count ${runningCount === 0 ? "none" : ""}`}
              >
                {runningCount}/{containers.length} running
              </span>
              {stoppedCount > 0 && (
                <span className="host-issue">{stoppedCount} stopped</span>
              )}
              {unhealthyCount > 0 && (
                <span className="host-issue host-issue--bad">
                  {unhealthyCount} unhealthy
                </span>
              )}
            </>
          )}
        </button>

        <div className="host-controls">
          <SortControl
            value={sortBy}
            onChange={(value) => onHostState({ sortBy: value })}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="container-list">
          <ContainerTableHead />
          {ordered.map((container) => (
            <ContainerRow
              key={container.id}
              container={container}
              host={host}
              hostCores={hostCores}
              staleAge={staleAge}
              pending={onControl.pending}
              errors={onControl.errors}
              onControl={onControl.run}
              onClearError={onControl.clearError}
              pinned={false}
              onTogglePin={() => onTogglePin(pinKey(host, container.name))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContainerList({
  containers,
  machines,
  onControl,
  pins,
  onSetPins,
  connected,
}) {
  const {
    settings: { highRestartCount, showContainerUptime },
  } = useSettings();
  const hosts = useMemo(() => Object.keys(containers).sort(), [containers]);

  const [query, setQuery] = useLocalStorage("homelab.containerSearch", "");
  const [statusFilter, setStatusFilter] = useLocalStorage(
    "homelab.containerStatusFilter",
    "all"
  );
  const [hostState, setHostState] = useLocalStorage(
    "homelab.containerHostState",
    {}
  );
  // Pinned strip starts open; a manual collapse sticks (adding more
  // favourites while it's closed keeps it closed, just updates the count).
  const [pinnedCollapsed, setPinnedCollapsed] = useLocalStorage(
    "homelab.pinnedCollapsed",
    false
  );

  const pinSet = useMemo(() => new Set(pins), [pins]);

  // Tag every container with its host so a pinned row (shown outside its
  // host group) still knows where it lives.
  const withHost = useMemo(() => {
    const map = {};
    for (const host of hosts) {
      map[host] = (containers[host] || []).map((c) => ({ ...c, __host: host }));
    }
    return map;
  }, [containers, hosts]);

  const isPinned = (c) => pinSet.has(pinKey(c.__host, c.name));
  const passes = (c) =>
    matchesQuery(c, query) && matchesStatus(c, statusFilter, highRestartCount);

  const pinnedContainers = useMemo(
    () =>
      hosts
        .flatMap((h) => withHost[h])
        .filter((c) => pinSet.has(pinKey(c.__host, c.name)))
        .filter(passes)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosts, withHost, pinSet, query, statusFilter, highRestartCount]
  );

  const setPin = (key) => onSetPins(togglePin(pins, key));

  const updateHostState = (host, patch) =>
    setHostState((current) => ({
      ...current,
      [host]: { ...current[host], ...patch },
    }));

  const totalMatches = hosts.reduce(
    (sum, host) => sum + withHost[host].filter(passes).length,
    0
  );
  const filtering = Boolean(query) || statusFilter !== "all";

  const setAllCollapsed = (collapsed) =>
    setHostState((current) =>
      Object.fromEntries(
        hosts.map((host) => [host, { ...current[host], collapsed }])
      )
    );

  return (
    <section
      className={`containers-section ${showContainerUptime ? "" : "no-uptime"}`}
    >
      {hosts.length === 0 ? (
        <div className="empty-state">
          {connected === false
            ? "Connecting…"
            : "No agents reporting containers yet."}
        </div>
      ) : (
        <div className="container-toolbar">
          <div className="container-search">
            <input
              type="search"
              placeholder="Filter by name or image…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter containers"
            />
          </div>

          <div className="segmented" role="group" aria-label="Status filter">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={statusFilter === f.value ? "active" : ""}
                aria-pressed={statusFilter === f.value}
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="container-toolbar-end">
            {filtering && (
              <span className="container-search-count">
                {totalMatches} match{totalMatches === 1 ? "" : "es"}
              </span>
            )}
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setAllCollapsed(false)}
            >
              Expand all
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setAllCollapsed(true)}
            >
              Collapse all
            </button>
          </div>
        </div>
      )}

      {pinnedContainers.length > 0 && (() => {
        const pinnedOpen = filtering ? true : !pinnedCollapsed;
        return (
          <div className="pinned-strip">
            <button
              type="button"
              className={`pinned-strip-title ${pinnedOpen ? "expanded" : ""}`}
              onClick={() => setPinnedCollapsed((c) => !c)}
              aria-expanded={pinnedOpen}
            >
              <span className="host-toggle">▾</span>
              <span className="pinned-strip-star">★</span>
              Pinned
              <span className="host-running-count">{pinnedContainers.length}</span>
            </button>
            {pinnedOpen && (
              <div className="container-list">
                <ContainerTableHead />
                {pinnedContainers.map((container) => (
                  <ContainerRow
                    key={`${container.__host}-${container.id}`}
                    container={container}
                    host={container.__host}
                    hostCores={machines?.[container.__host]?.cpu_cores}
                    staleAge={machines?.[container.__host]?.agent_stale_age}
                    pending={onControl.pending}
                    errors={onControl.errors}
                    onControl={onControl.run}
                    onClearError={onControl.clearError}
                    pinned
                    showHost
                    onTogglePin={() =>
                      setPin(pinKey(container.__host, container.name))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {hosts.map((host) => {
        // Pinned containers live in the strip above, not in their group.
        const groupContainers = withHost[host].filter((c) => !isPinned(c));
        const visible = groupContainers.filter(passes);
        if (filtering && visible.length === 0) return null;

        return (
          <HostGroup
            key={host}
            host={host}
            containers={filtering ? visible : groupContainers}
            hostCores={machines?.[host]?.cpu_cores}
            agentReachable={machines?.[host]?.agent_reachable}
            staleAge={machines?.[host]?.agent_stale_age}
            onControl={onControl}
            onTogglePin={setPin}
            sortBy={hostState[host]?.sortBy ?? "name"}
            collapsed={filtering ? false : hostState[host]?.collapsed ?? false}
            onHostState={(patch) => updateHostState(host, patch)}
            restartThreshold={highRestartCount}
          />
        );
      })}
    </section>
  );
}

export default ContainerList;
