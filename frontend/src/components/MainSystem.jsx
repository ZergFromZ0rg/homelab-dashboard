import MachineVitals from "./MachineVitals";

function MainSystem({ host, machine, history }) {
  return (
    <section className={`main-system ${machine.online ? "online" : "offline"}`}>
      <div className="main-system-header">
        <div>
          <p className="eyebrow">Main System</p>
          <h2>{host}</h2>
        </div>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <MachineVitals machine={machine} history={history} />
    </section>
  );
}

export default MainSystem;
