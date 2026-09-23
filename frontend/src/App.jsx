import ContainerList from "./components/ContainerList";
import Tabs from "./components/Tabs";
import DeployTab from "./components/DeployTab";
import Overview from "./components/Overview";
import BackupsTab from "./components/BackupsTab";
import ServersTab from "./components/ServersTab";
import ServicesTab from "./components/ServicesTab";
import PersonalTab from "./components/PersonalTab";
import SiteSettings from "./components/SiteSettings";
import SettingsDrawer from "./components/SettingsDrawer";
import { useSettings } from "./components/settings";
import { SettingsProvider } from "./components/SettingsContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadCachedPins, cachePins, putPins } from "./components/containerPins";
import { loadCachedTodos, cacheTodos, putTodos } from "./components/todosApi";
import "./App.css";
import "./theme.css";
import { tabColor } from "./components/tabColors";
import brandImage from "./assets/brand.webp";
import { DEMO, demoSnapshot } from "./demoData";

const EMPTY_OVERVIEW = { ok: true, issues: [], recommendations: [] };

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

      ws.onopen = () => {
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
        });
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
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

  return <div className={className}>{label}</div>;
}

// Sticky top bar (brand, sections, connection, settings gear) around the
// page content. Lives inside SettingsProvider so the title can be a setting.
function AppShell({ tabs, activeTab, onTab, connected, lastUpdate, onOpenSettings, children }) {
  const {
    settings: { siteTitle, siteSubtitle },
  } = useSettings();

  // The active tab's color tints the page backdrop, so the section you're
  // in is a color before it's a word.
  return (
    <div className="app" style={{ "--page-accent": tabColor(activeTab) }}>
      <header className="topbar">
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

          <Tabs tabs={tabs} active={activeTab} onChange={onTab} />

          <div className="topbar-actions">
            <ConnectionStatus connected={connected} lastUpdate={lastUpdate} />
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
    pins,
    todos,
    mainHost,
    connected,
    lastUpdate,
    setPins,
    setTodos,
  } = useDashboardSocket();

  const [activeTab, setActiveTab] = useState("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const control = useContainerControl();

  const totalContainers = Object.values(containers).reduce(
    (sum, list) => sum + list.length,
    0
  );

  const activeDeployments = deployments.filter(
    (d) => d.status === "running" || d.status === "placing"
  ).length;

  const openTodos = todos.filter((t) => !t.done).length;

  const hostNames = Object.keys(machines);
  const hostsOffline = hostNames.filter((n) => !machines[n].online).length;

  const tabs = [
    {
      value: "overview",
      label: "Overview",
      count: overview.ok ? null : overview.issues.length,
      tone: "bad",
    },
    {
      value: "servers",
      label: "Servers",
      count: hostNames.length || null,
      tone: hostsOffline ? "bad" : undefined,
    },
    { value: "containers", label: "Containers", count: totalContainers },
    {
      value: "services",
      label: "Services",
      count: checks.length || null,
      tone: checks.some((c) => c.status === "down") ? "bad" : undefined,
    },
    { value: "deploy", label: "Deploy", count: activeDeployments },
    {
      value: "backups",
      label: "Backups",
      count: backups?.total || null,
      tone: backups?.attention ? "bad" : undefined,
    },
    { value: "personal", label: "Personal", count: openTodos || null },
  ];

  // Anything that says "go look at X" (Attention → View, Quick actions →
  // Containers) funnels through here.
  const navigate = (target) => {
    if (target === "settings") setSettingsOpen(true);
    else setActiveTab(target);
  };

  return (
    <SettingsProvider>
      <AppShell
        tabs={tabs}
        activeTab={activeTab}
        onTab={setActiveTab}
        connected={connected}
        lastUpdate={lastUpdate}
        onOpenSettings={() => setSettingsOpen(true)}
      >
        {activeTab === "overview" && (
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
            onControl={control}
            onNavigate={navigate}
          />
        )}

        {activeTab === "servers" && (
          <ServersTab
            machines={machines}
            containers={containers}
            history={history}
            mainHost={mainHost}
            connected={connected}
          />
        )}

        {activeTab === "containers" && (
          <ContainerList
            containers={containers}
            machines={machines}
            onControl={control}
            pins={pins}
            onSetPins={setPins}
            connected={connected}
          />
        )}

        {activeTab === "services" && (
          <ServicesTab checks={checks} connected={connected} />
        )}

        {activeTab === "deploy" && (
          <DeployTab machines={machines} deployments={deployments} connected={connected} />
        )}

        {activeTab === "backups" && (
          <BackupsTab machines={machines} connected={connected} />
        )}

        {activeTab === "personal" && (
          <PersonalTab
            overview={overview}
            todos={todos}
            onSetTodos={setTodos}
            openTodos={openTodos}
            checks={checks}
          />
        )}

        <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)}>
          <SiteSettings pins={pins} containers={containers} />
        </SettingsDrawer>
      </AppShell>
    </SettingsProvider>
  );
}

export default App;
