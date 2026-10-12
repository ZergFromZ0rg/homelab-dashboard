import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";

// One server on its Summary page: a header line, then its full vitals. `main`
// marks the host the dashboard itself runs on. Its files, shell and system
// controls are pages of their own beside this one.
function MachineCard({ name, machine, history, containers, main = false, onOpenFolder }) {
  return (
    <div
      className={`machine-card ${main ? "machine-card--main" : ""} ${
        machine.online ? "online" : "offline"
      }`}
    >
      <div className="machine-header">
        <div className="machine-fold">
          <span className="status-dot" />
          <h2>{name}</h2>
          {main && <span className="machine-badge">Dashboard host</span>}
        </div>

        <span className="machine-header-end">
          {!machine.online && <span className="machine-offline">offline</span>}
        </span>
      </div>

      <MachineVitals machine={machine} history={history} containers={containers} onOpenFolder={onOpenFolder} />
      <HostFooter machine={machine} containers={containers} />
    </div>
  );
}

export default MachineCard;
