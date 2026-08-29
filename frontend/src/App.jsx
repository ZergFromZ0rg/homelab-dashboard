import ContainerList from "./components/ContainerList";
import { useEffect, useState } from "react";
import "./App.css";
import MachineCard from "./components/MachineCard";

function App() {
  const [machines, setMachines] = useState({});
  const [containers, setContainers] = useState({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    const ws = new WebSocket(
       `${protocol}//${window.location.host}/ws`
    );
    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "dashboard_update") {
   
        setMachines(data.machines);
        setContainers(data.containers);
      }
    };
   
    ws.onclose = () => {
      setConnected(false);
    };

    return () => ws.close();
  }, []);

  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Zerg Homelab</p>
          <h1>System Dashboard</h1>
        </div>

        <div className={`connection ${connected ? "connected" : ""}`}>
          {connected ? "LIVE" : "DISCONNECTED"}
        </div>
      </header>

      <section className="machine-grid">
        {Object.entries(machines).map(([name, machine]) => (
          <MachineCard
            key={name}
            name={name}
            machine={machine}
          />
        ))}
      </section>

      <ContainerList containers={containers} />

    </main>
  );
}

export default App;
