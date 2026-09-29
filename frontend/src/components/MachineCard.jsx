import MachineVitals from "./MachineVitals";
import HostFooter from "./HostFooter";
import HostShellButton from "./HostShellButton";
import Icon, { IconButton } from "./Icon";
import { Meter } from "./HostSummary";
import { diskLabel } from "./diskLabel";
import { useRef, useState } from "react";
import { useFocusRequest } from "./focusRequest";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

// One server: a header line that folds the card down to just CPU / RAM /
// fullest disk bars, and under it the full vitals. `main` marks the host
// the dashboard itself runs on. Folded state is remembered per host.
function MachineCard({ name, machine, history, containers, main = false }) {
  const [explore, setExplore] = useState(null);
  const [folded, setFolded] = useLocalStorage("hostFolded", {});
  const isFolded = Boolean(folded?.[name]);
  const setFold = (value) => setFolded((all) => ({ ...all, [name]: value }));
  const card = useRef(null);
  // The command palette: "show name" / "files on name".
  useFocusRequest(name, (action) => {
    setFold(false);
    if (action === "files") setExplore("~");
    card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const list = containers || [];
  const running = list.filter((c) => c.status === "running").length;
  const fullest = [...(machine.filesystems || [])].sort(
    (a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0)
  )[0];

  return (
    <div
      ref={card}
      className={`machine-card ${main ? "machine-card--main" : ""} ${isFolded ? "machine-card--folded" : ""} ${
        machine.online ? "online" : "offline"
      }`}
      style={{ "--host-color": hostColor(name) }}
    >
      <div className="machine-header">
        <button
          type="button"
          className="machine-fold"
          aria-expanded={!isFolded}
          onClick={() => setFold(!isFolded)}
          title={isFolded ? `Show ${name}` : `Fold ${name}`}
        >
          <span className="machine-fold-caret" aria-hidden="true"><Icon name="chevron" size={12} /></span>
          <span className="status-dot" />
          <h2 style={{ color: hostColor(name) }}>{name}</h2>
          {main && <span className="machine-badge">Dashboard host</span>}
        </button>

        {isFolded && machine.online && (
          <span className="machine-fold-meters">
            <Meter label="CPU" pct={machine.cpu} />
            <Meter label="RAM" pct={machine.ram} />
            <Meter label={fullest ? diskLabel(fullest) : "Disk"} pct={fullest?.used_percent} />
            <span className="ov-host-count" title="containers running">{running}/{list.length}</span>
          </span>
        )}

        <span className="machine-header-end">
          {machine.agent_reachable && (
            <IconButton
              icon="folder"
              label={`Browse files on ${name}`}
              active={Boolean(explore)}
              onClick={() => {
                setFold(false);
                setExplore((open) => (open ? null : "~"));
              }}
            />
          )}
          <HostShellButton host={name} />
          {!machine.online && <span className="machine-offline">offline</span>}
        </span>
      </div>

      {!isFolded && (
        <>
          <MachineVitals
            host={name}
            machine={machine}
            history={history}
            explore={explore}
            onExplore={setExplore}
          />
          <HostFooter machine={machine} containers={containers} />
        </>
      )}
    </div>
  );
}

export default MachineCard;
