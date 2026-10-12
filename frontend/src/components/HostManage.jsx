import { OsUpdates, Power } from "./HostSystem";
import HostRecovery from "./HostRecovery";
import HostSettings from "./HostSettings";

// Changing the machine itself: pending OS updates, reboot and power off, what
// you would lose if it died, and its agent's settings. Two columns of panels.
function HostManage({ host, machine }) {
  return (
    <div className="host-manage">
      {!machine.terminal && (
        <p className="settings-hint system-off">
          Host control is off on {host}'s agent — set <code>TERMINAL_ENABLED=1</code> in its{" "}
          <code>.env</code> to manage updates and power from here.
        </p>
      )}
      <div className="host-manage-grid">
        <div className="host-manage-col">
          {machine.terminal && (
            <>
              <section className="overview-card">
                <div className="overview-card-head">
                  <h2>OS updates</h2>
                </div>
                <div className="host-manage-body">
                  <OsUpdates key={host} host={host} facts={machine.host_facts} />
                </div>
              </section>
              <section className="overview-card">
                <div className="overview-card-head">
                  <h2>Power</h2>
                </div>
                <div className="host-manage-body">
                  <Power key={host} host={host} machine={machine} />
                </div>
              </section>
            </>
          )}
        </div>
        <div className="host-manage-col">
          <section className="overview-card">
            <HostRecovery key={`r-${host}`} host={host} defaultOpen />
          </section>
          <section className="overview-card">
            <HostSettings key={`s-${host}`} host={host} defaultOpen />
          </section>
        </div>
      </div>
    </div>
  );
}

export default HostManage;
