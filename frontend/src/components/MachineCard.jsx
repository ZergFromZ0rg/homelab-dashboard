import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostShellButton from "./HostShellButton";
import { IconButton } from "./Icon";
import { useState } from "react";
import { hostColor } from "./hostColor";

function MachineCard({ name, machine, history, containers }) {
  const [explore, setExplore] = useState(null);
  return (
    <div
      className={`machine-card ${machine.online ? "online" : "offline"}`}
      style={{ "--host-color": hostColor(name) }}
    >
      <div className="machine-header">
        <h2 style={{ color: hostColor(name) }}>{name}</h2>

        <span className="machine-header-end">
          {machine.agent_reachable && (
            <IconButton
              icon="folder"
              label={`Browse files on ${name}`}
              active={Boolean(explore)}
              onClick={() => setExplore((open) => (open ? null : "~"))}
            />
          )}
          <HostShellButton host={name} />
          <span className="status">
            <span className="status-dot" />
            {machine.online ? "ONLINE" : "OFFLINE"}
          </span>
        </span>
      </div>

      <MachineVitals
        host={name}
        machine={machine}
        history={history}
        explore={explore}
        onExplore={setExplore}
      />
      <HostFooter machine={machine} containers={containers} />
    </div>
  );
}

export default MachineCard;
