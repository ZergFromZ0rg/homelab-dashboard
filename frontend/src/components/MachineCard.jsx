import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostShellButton from "./HostShellButton";
import { IconButton } from "./Icon";
import { useRef, useState } from "react";
import { useFocusRequest } from "./focusRequest";
import { hostColor } from "./hostColor";

function MachineCard({ name, machine, history, containers }) {
  const [explore, setExplore] = useState(null);
  const card = useRef(null);
  // The command palette: "show name" / "files on name".
  useFocusRequest(name, (action) => {
    if (action === "files") setExplore("~");
    else card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  return (
    <div
      ref={card}
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
