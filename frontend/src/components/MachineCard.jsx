import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostStatusBand from "./HostStatusBand";
import { hostColor } from "./hostColor";

// One server on its Health page: a header line, its containers and failed
// services, then its full vitals. `main` marks the host the dashboard itself
// runs on. Its files, shell and system controls are pages of their own beside
// this one.
function MachineCard({ name, machine, history, containers, main = false, onOpenFolder, onOpenContainers, onOpenServices }) {
  return (
    <div
      className={`machine-card ${main ? "machine-card--main" : ""} ${
        machine.online ? "online" : "offline"
      }`}
      style={{ "--host-color": hostColor(name) }}
    >
      <div className="machine-header">
        <div className="machine-fold">
          <span className="status-dot" />
          <h2 style={{ color: hostColor(name) }}>{name}</h2>
          {main && <span className="machine-badge">Dashboard host</span>}
        </div>

        <span className="machine-header-end">
          {!machine.online && <span className="machine-offline">offline</span>}
        </span>
      </div>

      <HostStatusBand
        machine={machine}
        containers={containers}
        onOpenContainers={onOpenContainers}
        onOpenServices={onOpenServices}
      />
      <MachineVitals machine={machine} history={history} containers={containers} onOpenFolder={onOpenFolder} />
      <HostFooter machine={machine} containers={containers} />
    </div>
  );
}

export default MachineCard;
