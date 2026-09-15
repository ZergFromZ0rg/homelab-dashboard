import MachineVitals from "./MachineVitals";
import { hostColor } from "./hostColor";

// The machine the dashboard itself runs on — same card size as every
// other node (it's not more important, just easier to find), marked out
// with a light-blue outline and badge instead of a separate full-width
// section.
function MainSystem({ host, machine, history }) {
  return (
    <div
      className={`machine-card machine-card--main ${
        machine.online ? "online" : "offline"
      }`}
    >
      <div className="machine-header">
        <h2>
          <span style={{ color: hostColor(host) }}>{host}</span>
          <span className="machine-badge">Dashboard host</span>
        </h2>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <MachineVitals machine={machine} history={history} />
    </div>
  );
}

export default MainSystem;
