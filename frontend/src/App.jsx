import ContainerList from "./components/ContainerList";
import Tabs from "./components/Tabs";
import Overview from "./components/Overview";
import BackupsTab from "./components/BackupsTab";
import NetworkTab from "./components/NetworkTab";
import SystemTab from "./components/SystemTab";
import FilesTab from "./components/FilesTab";
import TerminalTab from "./components/TerminalTab";
import PersonalTab from "./components/PersonalTab";
import SimpleHome from "./components/SimpleHome";
import { requestFocus } from "./components/focusRequest";
import SiteSettings from "./components/SiteSettings";
import SettingsDrawer from "./components/SettingsDrawer";
import TerminalDock from "./components/TerminalDock";
import UpdatesProvider from "./components/UpdatesProvider";
import CommandPalette from "./components/CommandPalette";
import { useSettings } from "./components/settings";
import { SettingsProvider } from "./components/SettingsContext";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { loadCachedPins, cachePins, putPins } from "./components/containerPins";
import { loadCachedTodos, cacheTodos, putTodos } from "./components/todosApi";
import "./App.css";
import "./theme.css";
import { tabColor } from "./components/tabColors";
import brandImage from "./assets/brand.webp";
import { DEMO, demoSnapshot } from "./demoData";
import { AUTH_REQUIRED_EVENT } from "./components/apiAuth";
import ModeSelector from "./components/ModeSelector";
import { useModeSelector } from "./components/viewMode";
import MorningBriefing from "./components/MorningBriefing";

const EMPTY_OVERVIEW = { ok: true, issues: [], recommendations: [] };

const ContainerSettings = lazy(() => import("./components/ContainerSettings"));

function useContainerControl() {
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});

  async function run(host, containerId, action) {
    const key = `${host}-${containerId}`;

    setPending((current) => ({ ...current, [key]: action }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const response = await fetch(
        `/api/containers/${host}/${containerId}/${action}`,
        { method: "POST" }
      );

      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.success === false) {
        throw new Error(body.error || `Request failed: ${response.status}`);
      }
    } catch (error) {
      console.error("Container control failed:", error);
      setErrors((current) => ({
        ...current,
        [key]: `${action} failed: ${error.message}`,
      }));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function clearError(key) {
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  return { pending, errors, run, clearError };
}

// State the server owns (pins, todos): the WebSocket pushes the
// canonical copy, edits go out as an optimistic PUT that rolls back on
// failure, and a localStorage cache fills the first paint before the
// first WS tick. `adopt` and `set` are stable (they work through a
// ref), so the socket effect can close over them without going stale.
function useServerList(loadCached, cache, put) {
  const [items, setItems] = useState(loadCached);
  const ref = useRef(items);

  const adopt = useCallback(
    (serverItems) => {
      if (serverItems == null) return;
      if (JSON.stringify(serverItems) === JSON.stringify(ref.current)) return;
      ref.current = serverItems;
      cache(serverItems);
      setItems(serverItems);
    },
    [cache]
  );

  const set = useCallback(
    async (next) => {
      const previous = ref.current;
      ref.current = next;
      cache(next);
      setItems(next);
      try {
        const confirmed = await put(next);
        ref.current = confirmed;
        cache(confirmed);
        setItems(confirmed);
      } catch (error) {
        console.error("List save failed:", error);
        ref.current = previous;
        cache(previous);
        setItems(previous);
      }
    },
    [cache, put]
  );

  return [items, adopt, set];
}

// Reconnecting WebSocket. The bare `new WebSocket` in the first cut never
// retried — a dropped socket left the dashboard frozen until a manual
// refresh. Back off 1s → 2s → 4s … capped at 15s.
function useDashboardSocket() {
  const [demo] = useState(() => (DEMO ? demoSnapshot() : null));
  const [snap, setSnap] = useState(
    demo ?? {
      machines: {},
      containers: {},
      history: {},
      deployments: [],
      activity: [],
      alerts: [],
      backups: null,
      checks: [],
      mainHost: null,
      overview: EMPTY_OVERVIEW,
      morning_summary: null,
    }
  );
  const [connected, setConnected] = useState(Boolean(demo));
  const [lastUpdate, setLastUpdate] = useState(() => (demo ? Date.now() : null));

  const [pins, adoptPins, setPins] = useServerList(
    demo ? () => demo.pins : loadCachedPins,
    demo ? () => {} : cachePins,
    demo ? async (next) => next : putPins
  );
  const [todos, adoptTodos, setTodos] = useServerList(
    demo ? () => demo.todos : loadCachedTodos,
    demo ? () => {} : cacheTodos,
    demo ? async (next) => next : putTodos
  );

  useEffect(() => {
    if (demo) {
      const id = setInterval(() => setLastUpdate(Date.now()), 2000);
      return () => clearInterval(id);
    }
    let ws;
    let retryDelay = 1000;
    let reconnectTimer;
    let closed = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      let opened = false;

      ws.onopen = () => {
        opened = true;
        setConnected(true);
        retryDelay = 1000;
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type !== "dashboard_update") return;

        setLastUpdate(Date.now());
        adoptPins(data.pins);
        adoptTodos(data.todos);

        setSnap({
          machines: data.machines,
          containers: data.containers,
          history: data.history ?? {},
          deployments: data.deployments ?? [],
          activity: data.activity ?? [],
          alerts: data.alerts ?? [],
          backups: data.backups ?? null,
          checks: data.checks ?? [],
          mainHost: data.main_host ?? null,
          overview: data.overview ?? EMPTY_OVERVIEW,
          morning_summary: data.morning_summary ?? null,
        });
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Refused before it opened: maybe the session ended. The auth gate
        // re-checks and shows sign-in if so.
        if (!opened) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [demo, adoptPins, adoptTodos]);

  return {
    ...snap,
    pins,
    todos,
    connected,
    lastUpdate,
    // False until the first snapshot lands: the empty placeholders above
    // mean "don't know yet", not "all clear".
    ready: lastUpdate != null,
    setPins,
    setTodos,
  };
}

function ConnectionStatus({ connected, lastUpdate }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const age = lastUpdate ? Math.floor((now - lastUpdate) / 1000) : null;
  // The /ws loop ticks every 2s; anything past ~8s means data we can't
  // trust even if the socket still looks open.
  const stale = age != null && age > 8;

  let label = "DISCONNECTED";
  let className = "connection";

  if (connected && !stale) {
    label = "LIVE";
    className = "connection connected";
  } else if (connected && stale) {
    label = `STALE ${age}s`;
    className = "connection stale";
  } else if (!connected && age != null) {
    label = `RECONNECTING · ${age}s`;
  }

  return <div className={className} title={label}>{label}</div>;
}

// Sticky top bar (brand, sections, connection, settings gear) around the
// page content. Lives inside SettingsProvider so the title can be a setting.
function AppShell({ tabs, activeTab, onTab, connected, lastUpdate, onOpenSettings, viewMode, onSetMode, children }) {
  const {
    settings: { siteTitle, siteSubtitle },
  } = useSettings();

  // The active tab's color tints the page backdrop, so the section you're
  // in is a color before it's a word.
  return (
    <div className={`app mode-${viewMode}`} style={{ "--page-accent": viewMode === "simple" ? "var(--accent)" : tabColor(activeTab) }}>
      <header className={`topbar ${viewMode === "god" ? "topbar--god" : ""}`}>
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <img src={brandImage} alt="" />
            </span>
            <div className="brand-text">
              <h1>{siteTitle}</h1>
              {siteSubtitle && <p className="eyebrow">{siteSubtitle}</p>}
            </div>
          </div>

          {viewMode !== "simple" && <Tabs tabs={tabs} active={activeTab} onChange={onTab} />}
          {viewMode === "simple" && <div className="tabs-spacer" />}

          <div className="topbar-actions">
            <ModeSelector mode={viewMode} onSetMode={onSetMode} />
            <ConnectionStatus connected={connected} lastUpdate={lastUpdate} />
            <button
              type="button"
              className="icon-btn"
              onClick={() => window.dispatchEvent(new Event("homelab:open-palette"))}
              aria-label="Search and commands"
              title="Search and commands (⌘K)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <path d="M16 16l4 4" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onOpenSettings}
              aria-label="Open settings"
              title="Settings"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="dashboard">{children}</main>
    </div>
  );
}

function App() {
  const {
    machines,
    containers,
    history,
    deployments,
    activity,
    alerts,
    backups,
    checks,
    overview,
    morning_summary,
    pins,
    todos,
    mainHost,
    connected,
    lastUpdate,
    ready,
    setPins,
    setTodos,
  } = useDashboardSocket();

  const { getMode, setMode } = useModeSelector();
  const [viewMode, setViewMode] = useState(getMode);

  useEffect(() => {
    const handleModeChange = () => setViewMode(getMode());
    // Another browser tab switched modes: follow it.
    const handleStorage = (e) => {
      if (e.key === "homelab.viewMode") handleModeChange();
    };
    window.addEventListener("homelab:mode-changed", handleModeChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("homelab:mode-changed", handleModeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, [getMode]);

  const [activeTab, setActiveTab] = useState("overview");
  // A new view starts at its top; keeping the old scroll offset dropped you
  // mid-page (or past the end) of a tab you hadn't read yet.
  const view = viewMode === "simple" ? "simple" : activeTab;
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    window.scrollTo({ top: 0 });
  }, [view]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Container settings opened from the palette (rows open their own).
  const [settingsFor, setSettingsFor] = useState(null);
  // Bumped to remount the container list after the palette writes its
  // search, which the list reads from localStorage when it mounts.
  const [containersKey, setContainersKey] = useState(0);
  // A folder another tab asked the Files tab to open ({host, path, n}).
  const [filesTarget, setFilesTarget] = useState(null);
  const control = useContainerControl();

  const totalContainers = Object.values(containers).reduce(
    (sum, list) => sum + list.length,
    0
  );

  const openTodos = todos.filter((t) => !t.done).length;
  const failedUnits = Object.values(machines).reduce(
    (n, m) => n + (m.host_facts?.failed_units?.length || 0),
    0
  );


  // Simple has no tabs (briefing, overview, personal on one page).
  // Advanced: the fleet (Overview — servers included), Containers, Backups.
  // God adds control of the machines themselves: Network, System (services,
  // updates, power, agent settings, hardware) and Terminal, plus shells. Deploy has no tab: placement lives on in
  // the API for the AI to drive.
  const tabs = [
    {
      value: "overview",
      label: "Overview",
      count: overview.ok ? null : overview.issues.length,
      tone: "bad",
    },
    { value: "containers", label: "Containers", count: totalContainers },
    { value: "files", label: "Files" },
    {
      value: "backups",
      label: "Backups",
      count: backups?.total || null,
      tone: backups?.attention ? "bad" : undefined,
    },
    ...(viewMode === "god"
      ? [
          {
            value: "network",
            label: "Network",
            count: checks.length || null,
            tone: checks.some((c) => c.status === "down") ? "bad" : undefined,
          },
          {
            value: "system",
            label: "System",
            count: failedUnits || null,
            tone: failedUnits ? "bad" : undefined,
          },
          { value: "terminal", label: "Terminal" },
        ]
      : []),
  ];
  const tabValues = tabs.map((t) => t.value);
  // A tab that doesn't exist in this mode (Network after leaving God) shows
  // the Overview instead.
  const shownTab = tabValues.includes(activeTab) ? activeTab : "overview";

  // Anything that says "go look at X" (Attention → View, Quick actions →
  // Containers) funnels through here.
  const navigate = (target, { container, host, path } = {}) => {
    if (target === "settings") return setSettingsOpen(true);
    if (container) {
      try {
        localStorage.setItem("homelab.containerSearch", JSON.stringify(container));
      } catch {
        // no storage: the tab still opens, just unfiltered
      }
      setContainersKey((k) => k + 1);
    }
    // Old section names land where their content lives now.
    if (target === "personal") return setMode("simple");
    const tab = target === "servers" || target === "deploy" ? "overview" : target;
    if (["network", "system", "terminal"].includes(tab) && viewMode !== "god") setMode("god");
    else if (viewMode === "simple") setMode("advanced");
    setActiveTab(tab);
    if (target === "servers" && host) requestFocus(host);
    if (target === "files" && host) setFilesTarget({ host, path, n: Date.now() });
  };
  const openSettingsFor = useCallback((host, container) => setSettingsFor({ host, container }), []);

  return (
    <SettingsProvider>
      <AppShell
        tabs={tabs}
        activeTab={shownTab}
        onTab={setActiveTab}
        connected={connected}
        lastUpdate={lastUpdate}
        onOpenSettings={() => setSettingsOpen(true)}
        viewMode={viewMode}
        onSetMode={setMode}
      >
        <UpdatesProvider>
        <TerminalDock
          machines={machines}
          shells={viewMode === "god"}
          full={viewMode === "god" && shownTab === "terminal"}
        >
        {viewMode === "simple" && (
          <div className="simple-mode-content view" key="simple">
            <SimpleHome
              overview={overview}
              backups={backups}
              machines={machines}
              containers={containers}
              checks={checks}
              alerts={alerts}
              pins={pins}
              todos={todos}
              onSetTodos={setTodos}
              openTodos={openTodos}
              ready={ready}
              onControl={control}
              briefing={<MorningBriefing summary={morning_summary} machines={machines} onNavigate={navigate} />}
              onNavigate={navigate}
            />
          </div>
        )}

        {viewMode !== "simple" && (
          <div className={`view view--${shownTab}`} key={shownTab}>
            {shownTab === "overview" && (
              <Overview
                overview={overview}
                backups={backups}
                machines={machines}
                containers={containers}
                checks={checks}
                deployments={deployments}
                activity={activity}
                alerts={alerts}
                pins={pins}
                history={history}
                mainHost={mainHost}
                ready={ready}
                detail
                onControl={control}
                onNavigate={navigate}
              />
            )}

            {shownTab === "containers" && (
              <ContainerList
                key={containersKey}
                containers={containers}
                machines={machines}
                onControl={control}
                pins={pins}
                onSetPins={setPins}
                connected={connected}
              />
            )}

            {shownTab === "files" && (
              <FilesTab
                machines={machines}
                connected={connected}
                target={filesTarget}
                onTargetUsed={() => setFilesTarget(null)}
              />
            )}

            {shownTab === "backups" && (
              <BackupsTab
                machines={machines}
                connected={connected}
                showLocation={viewMode === "god"}
                onOpenFolder={(host, path) => navigate("files", { host, path })}
              />
            )}

            {shownTab === "system" && (
              <SystemTab machines={machines} connected={connected} />
            )}

            {shownTab === "terminal" && (
              <TerminalTab machines={machines} containers={containers} />
            )}

            {shownTab === "network" && (
              <NetworkTab
                machines={machines}
                containers={containers}
                checks={checks}
                connected={connected}
              />
            )}
          </div>
        )}

        <CommandPalette
          tabs={tabs}
          machines={machines}
          containers={containers}
          control={control}
          onNavigate={navigate}
          onOpenSettings={openSettingsFor}
        />
        {settingsFor && (
          <Suspense fallback={null}>
            <ContainerSettings
              host={settingsFor.host}
              container={settingsFor.container}
              onClose={() => setSettingsFor(null)}
            />
          </Suspense>
        )}

        <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)}>
          <SiteSettings pins={pins} containers={containers} />
        </SettingsDrawer>
        </TerminalDock>
        </UpdatesProvider>
      </AppShell>
    </SettingsProvider>
  );
}

export default App;
