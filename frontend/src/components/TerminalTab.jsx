import { useLayoutEffect, useRef, useState } from "react";
import { useTerminal } from "./terminalContext";
import { hostColor } from "./hostColor";

// God mode's Terminal tab: a launcher line per server — a root shell on
// the machine, or a shell / the logs of any running container — over the
// terminal dock stretched to fill the page. The sessions are the dock's,
// so they keep running when you switch tabs and are still here when you
// come back.
function HostLauncher({ host, machine, containers }) {
  const terminal = useTerminal();
  const running = (containers || []).filter((c) => c.status === "running").sort((a, b) => a.name.localeCompare(b.name));
  const [picked, setPicked] = useState("");
  const container = running.find((c) => c.id === picked) || running[0];
  const shells = terminal?.available(host);

  return (
    <div className="tl-host" style={{ "--host-color": hostColor(host) }}>
      <span className={`status-dot status-dot--${machine.online ? "ok" : "bad"}`} />
      <strong className="tl-name">{host}</strong>
      <button
        type="button"
        className="btn btn--sm"
        disabled={!shells}
        title={shells ? `Root shell on ${host}` : `Host control is off on ${host}'s agent (TERMINAL_ENABLED)`}
        onClick={() => terminal.open({ host, target: "host" })}
      >
        Host shell
      </button>
      {running.length > 0 && (
        <>
          <select className="tl-select" value={container?.id || ""} onChange={(e) => setPicked(e.target.value)} aria-label={`Container on ${host}`}>
            {running.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!shells}
            onClick={() => terminal.open({ host, target: "container", container: container.id, name: container.name })}
          >
            Shell
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => terminal.open({ host, target: "logs", container: container.id, name: container.name })}
          >
            Logs
          </button>
        </>
      )}
    </div>
  );
}

function TerminalTab({ machines, containers }) {
  const terminal = useTerminal();
  const bar = useRef(null);
  const hosts = Object.keys(machines).sort();

  // The full-page dock starts where this bar ends.
  useLayoutEffect(() => {
    const place = () => {
      const bottom = bar.current?.getBoundingClientRect().bottom ?? 120;
      document.documentElement.style.setProperty("--term-full-top", `${Math.round(bottom + 8)}px`);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  });

  return (
    <section className="terminal-tab">
      <div className="tl-bar" ref={bar}>
        {hosts.map((h) => (
          <HostLauncher key={h} host={h} machine={machines[h]} containers={containers[h]} />
        ))}
      </div>
      {!terminal?.count && (
        <p className="tl-empty">
          Open a shell above. Terminals stay open when you switch tabs; logs open in any mode.
        </p>
      )}
    </section>
  );
}

export default TerminalTab;
