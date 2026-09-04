import ContainerList from "./components/ContainerList";
import MainSystem from "./components/MainSystem";
import MachineCard from "./components/MachineCard";
import SortControl from "./components/SortControl";
import { useEffect, useState } from "react";
import "./App.css";

function useContainerControl() {
  const [pending, setPending] = useState({});

  async function run(host, containerId, action) {
    const key = `${host}-${containerId}`;

    setPending((current) => ({ ...current, [key]: action }));

    try {
      const response = await fetch(
        `/api/containers/${host}/${containerId}/${action}`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
    } catch (error) {
      console.error("Container control failed:", error);
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  return { pending, run };
}

function App() {
  const [machines, setMachines] = useState({});
  const [containers, setContainers] = useState({});
  const [mainHost, setMainHost] = useState(null);
  const [connected, setConnected] = useState(false);
  const [sortBy, setSortBy] = useState("name");

  const control = useContainerControl();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "dashboard_update") {
        setMachines(data.machines);
        setContainers(data.containers);
        setMainHost(data.main_host ?? null);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    return () => ws.close();
  }, []);

  const hasMainHost = Boolean(mainHost && machines[mainHost]);

  const nodeNames = Object.keys(machines)
    .filter((name) => name !== mainHost)
    .sort();

  const nodeContainers = hasMainHost
    ? Object.fromEntries(
        Object.entries(containers).filter(([host]) => host !== mainHost)
      )
    : containers;

  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Zerg Homelab</p>
          <h1>System Dashboard</h1>
        </div>

        <div className="header-controls">
          <SortControl value={sortBy} onChange={setSortBy} />

          <div className={`connection ${connected ? "connected" : ""}`}>
            {connected ? "LIVE" : "DISCONNECTED"}
          </div>
        </div>
      </header>

      {hasMainHost && (
        <MainSystem
          host={mainHost}
          machine={machines[mainHost]}
          containers={containers[mainHost] || []}
          sortBy={sortBy}
          onControl={control}
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
              <MachineCard key={name} name={name} machine={machines[name]} />
            ))}
          </div>
        </section>
      )}

      <ContainerList
        containers={nodeContainers}
        sortBy={sortBy}
        onControl={control}
      />
    </main>
  );
}

export default App;
