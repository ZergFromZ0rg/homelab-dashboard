import MachineVitals from "./MachineVitals";

function MachineCard({ name, machine, history }) {
  return (
    <div className={`machine-card ${machine.online ? "online" : "offline"}`}>
      <div className="machine-header">
        <h2>{name}</h2>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <MachineVitals machine={machine} history={history} />
    </div>
  );
}

export default MachineCard;
