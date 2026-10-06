import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostShellButton from "./HostShellButton";
import { IconButton } from "./Icon";
import { useRef, useState } from "react";
import { useFocusRequest } from "./focusRequest";
import { hostColor } from "./hostColor";

// One server: a header line, then its full vitals. `main` marks the host
// the dashboard itself runs on.
function MachineCard({ name, machine, history, containers, main = false }) {
  const [explore, setExplore] = useState(null);
  // Bumped to open the System section on its OS updates.
  const [showUpdates, setShowUpdates] = useState(0);
  const card = useRef(null);
  // The command palette: "show name" / "files on name".
  useFocusRequest(name, (action) => {
    if (action === "files") setExplore("~");
    if (action === "os-updates") setShowUpdates((n) => n + 1);
    card.current?.scrollIntoView({ behavior: "smooth", block: "start", inline: "start" });
  });

  return (
    <div
      ref={card}
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
          {machine.agent_reachable && (
            <IconButton
              icon="folder"
              label={`Browse files on ${name}`}
              active={Boolean(explore)}
              onClick={() => setExplore((open) => (open ? null : "~"))}
            />
          )}
          <HostShellButton host={name} />
          {!machine.online && <span className="machine-offline">offline</span>}
        </span>
      </div>

      <>
          <MachineVitals
            host={name}
            machine={machine}
            history={history}
            containers={containers}
            explore={explore}
            onExplore={setExplore}
            showUpdates={showUpdates}
          />
          <HostFooter machine={machine} containers={containers} />
      </>
    </div>
  );
}

export default MachineCard;
