import ContainerList from "./components/ContainerList";
import MainSystem from "./components/MainSystem";
import MachineCard from "./components/MachineCard";
import Tabs from "./components/Tabs";
import DeployTab from "./components/DeployTab";
import Overview from "./components/Overview";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadCachedPins, cachePins, putPins } from "./components/containerPins";
import { loadCachedTodos, cacheTodos, putTodos } from "./components/todosApi";
import "./App.css";

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

// A list the server owns (pins, todos): the WebSocket pushes the canonical
// copy, edits go out as an optimistic PUT that rolls back on failure, and a
// localStorage cache fills the first paint before the first WS tick.
// `adopt` and `set` are stable (they work through a ref), so the socket
// effect can close over them without going stale.
function useServerList(loadCached, cache, put) {
  const [items, setItems] = useState(loadCached);
  const ref = useRef(items);

  const adopt = useCallback(
    (serverItems) => {
      if (!Array.isArray(serverItems)) return;
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
  const [snap, setSnap] = useState({
    machines: {},
    containers: {},
    history: {},
    deployments: [],
    activity: [],
    mainHost: null,
    overview: EMPTY_OVERVIEW,
  });
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  const [pins, adoptPins, setPins] = useServerList(
    loadCachedPins,
    cachePins,
    putPins
  );
  const [todos, adoptTodos, setTodos] = useServerList(
    loadCachedTodos,
    cacheTodos,
    putTodos
  );

  useEffect(() => {
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
  }, [adoptPins, adoptTodos]);

  return { ...snap, pins, todos, connected, lastUpdate, setPins, setTodos };
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

function App() {
  const {
    machines,
    containers,
    history,
    deployments,
    activity,
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
  const control = useContainerControl();

  const hasMainHost = Boolean(mainHost && machines[mainHost]);

  const nodeNames = Object.keys(machines)
    .filter((name) => name !== mainHost)
    .sort();

  const totalContainers = Object.values(containers).reduce(
    (sum, list) => sum + list.length,
    0
  );

  const activeDeployments = deployments.filter(
    (d) => d.status === "running" || d.status === "placing"
  ).length;

  const openTodos = todos.filter((t) => !t.done).length;

  const tabs = [
    {
      value: "overview",
      label: overview.ok ? "Overview" : `Overview (${overview.issues.length})`,
    },
    { value: "system", label: "System Stats" },
    { value: "containers", label: `Containers (${totalContainers})` },
    { value: "deploy", label: `Deploy (${activeDeployments})` },
  ];

  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Zerg Homelab</p>
          <h1>System Dashboard</h1>
        </div>

        <ConnectionStatus connected={connected} lastUpdate={lastUpdate} />
      </header>

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" && (
        <Overview
          overview={overview}
          machines={machines}
          containers={containers}
          deployments={deployments}
          activity={activity}
          pins={pins}
          todos={todos}
          openTodos={openTodos}
          onControl={control}
          onSetTodos={setTodos}
          onNavigate={setActiveTab}
        />
      )}

      {activeTab === "system" && (
        <>
          {hasMainHost && (
            <MainSystem
              host={mainHost}
              machine={machines[mainHost]}
              history={history[mainHost]}
            />
          )}

          {nodeNames.length > 0 && (
            <section className="nodes-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Fleet</p>
                  <h2>Nodes</h2>
                </div>
              </div>

              <div className="machine-grid">
                {nodeNames.map((name) => (
                  <MachineCard
                    key={name}
                    name={name}
                    machine={machines[name]}
                    history={history[name]}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === "containers" && (
        <ContainerList
          containers={containers}
          machines={machines}
          onControl={control}
          pins={pins}
          onSetPins={setPins}
        />
      )}

      {activeTab === "deploy" && (
        <DeployTab machines={machines} deployments={deployments} />
      )}
    </main>
  );
}

export default App;
