import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import { hostColor } from "./hostColor";

function MachineCard({ name, machine, history, containers }) {
  return (
    <div className={`machine-card ${machine.online ? "online" : "offline"}`}>
      <div className="machine-header">
        <h2 style={{ color: hostColor(name) }}>{name}</h2>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <MachineVitals machine={machine} history={history} />
      <HostFooter machine={machine} containers={containers} />
    </div>
  );
}

export default MachineCard;
