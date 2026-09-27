import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostShellButton from "./HostShellButton";
import { IconButton } from "./Icon";
import { useRef, useState } from "react";
import { useFocusRequest } from "./focusRequest";
import { hostColor } from "./hostColor";

// The machine the dashboard itself runs on — same card size as every
// other node (it's not more important, just easier to find), marked out
// with a light-blue outline and badge instead of a separate full-width
// section.
function MainSystem({ host, machine, history, containers }) {
  const [explore, setExplore] = useState(null);
  const card = useRef(null);
  // The command palette: "show host" / "files on host".
  useFocusRequest(host, (action) => {
    if (action === "files") setExplore("~");
    else card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  return (
    <div
      ref={card}
      className={`machine-card machine-card--main ${
        machine.online ? "online" : "offline"
      }`}
      style={{ "--host-color": hostColor(host) }}
    >
      <div className="machine-header">
        <h2>
          <span style={{ color: hostColor(host) }}>{host}</span>
          <span className="machine-badge">Dashboard host</span>
        </h2>

        <span className="machine-header-end">
          {machine.agent_reachable && (
            <IconButton
              icon="folder"
              label={`Browse files on ${host}`}
              active={Boolean(explore)}
              onClick={() => setExplore((open) => (open ? null : "~"))}
            />
          )}
          <HostShellButton host={host} />
          <span className="status">
            <span className="status-dot" />
            {machine.online ? "ONLINE" : "OFFLINE"}
          </span>
        </span>
      </div>

      <MachineVitals
        host={host}
        machine={machine}
        history={history}
        explore={explore}
        onExplore={setExplore}
      />
      <HostFooter machine={machine} containers={containers} />
    </div>
  );
}

export default MainSystem;
