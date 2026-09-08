import ContainerList from "./components/ContainerList";
import MainSystem from "./components/MainSystem";
import MachineCard from "./components/MachineCard";
import Tabs from "./components/Tabs";
import DeployTab from "./components/DeployTab";
import { useEffect, useRef, useState } from "react";
import { loadCachedPins, cachePins, putPins } from "./components/containerPins";
import "./App.css";

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

// Reconnecting WebSocket. The bare `new WebSocket` in the first cut never
// retried — a dropped socket left the dashboard frozen until a manual
// refresh. Back off 1s → 2s → 4s … capped at 15s.
function useDashboardSocket() {
  const [state, setState] = useState({
    machines: {},
    containers: {},
    history: {},
    deployments: [],
    pins: loadCachedPins(),
    mainHost: null,
  });
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const pinsRef = useRef(state.pins);

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

        // The server owns the pin list; only adopt it when it actually
        // changed so a local optimistic edit isn't clobbered mid-flight.
        const serverPins = Array.isArray(data.pins) ? data.pins : pinsRef.current;
        const pinsChanged =
          serverPins.length !== pinsRef.current.length ||
          serverPins.some((k, i) => k !== pinsRef.current[i]);
        if (pinsChanged) {
          pinsRef.current = serverPins;
          cachePins(serverPins);
        }

        setState((current) => ({
          machines: data.machines,
          containers: data.containers,
          history: data.history ?? {},
          deployments: data.deployments ?? [],
          pins: pinsChanged ? serverPins : current.pins,
          mainHost: data.main_host ?? null,
        }));
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
  }, []);

  // Optimistic local pin edit, pushed to the backend. On failure, roll
  // back to whatever the server last told us.
  async function setPins(nextPins) {
    const previous = pinsRef.current;
    pinsRef.current = nextPins;
    cachePins(nextPins);
    setState((current) => ({ ...current, pins: nextPins }));

    try {
      const confirmed = await putPins(nextPins);
      pinsRef.current = confirmed;
      cachePins(confirmed);
      setState((current) => ({ ...current, pins: confirmed }));
    } catch (error) {
      console.error("Saving pins failed:", error);
      pinsRef.current = previous;
      cachePins(previous);
      setState((current) => ({ ...current, pins: previous }));
    }
  }

  return { ...state, connected, lastUpdate, setPins };
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
    pins,
    mainHost,
    connected,
    lastUpdate,
    setPins,
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

  const tabs = [
    { value: "overview", label: "Server Overview" },
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
