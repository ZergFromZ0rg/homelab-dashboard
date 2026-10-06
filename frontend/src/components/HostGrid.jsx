import { useEffect, useRef, useState } from "react";
import MachineCard from "./MachineCard";
import { hostColor } from "./hostColor";

// Every host's full vitals as a row of slides: one server per screen width,
// the dashboard's own host first. Swipe or scroll sideways (or use the node
// buttons) to move between them; each slide scrolls on its own when the card
// is taller than the window.
function HostGrid({ machines, containers, history, mainHost, children }) {
  const names = Object.keys(machines).sort((a, b) =>
    a === mainHost ? -1 : b === mainHost ? 1 : a.localeCompare(b)
  );
  const track = useRef(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = track.current;
    if (!el) return undefined;
    const onScroll = () => setActive(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  if (names.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  const go = (i) => {
    const el = track.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  return (
    <div className="ovw-hosts">
      <div className="ovw-pager" role="tablist" aria-label="Servers">
        {names.map((name, i) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={active === i}
            className={active === i ? "active" : ""}
            style={{ "--host-color": hostColor(name) }}
            onClick={() => go(i)}
          >
            <span className={`status-dot status-dot--${machines[name].online ? "ok" : "bad"}`} />
            {name}
          </button>
        ))}
        {children}
      </div>
      <div className="ovw-track" ref={track}>
        {names.map((name) => (
          <div className="ovw-slide" key={name}>
            <MachineCard
              name={name}
              machine={machines[name]}
              history={history[name]}
              containers={containers?.[name]}
              main={name === mainHost}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default HostGrid;
