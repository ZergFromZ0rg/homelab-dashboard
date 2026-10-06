import { useLayoutEffect, useRef, useState } from "react";
import { useTerminal } from "./terminalContext";
import { hostColor } from "./hostColor";
import { useFitHeight } from "./useFitHeight";

// The sessions are the dock's, so they keep running when you switch tabs and
// are still here when you come back.
function HostLauncher({ host, machine, containers }) {
  const terminal = useTerminal();
  const running = (containers || []).filter((c) => c.status === "running").sort((a, b) => a.name.localeCompare(b.name));
  const [picked, setPicked] = useState("");
  const container = running.find((c) => c.id === picked) || running[0];
  const shells = terminal?.available(host);
  const off = `Host control is off on ${host}'s agent (TERMINAL_ENABLED)`;

  return (
    <div className="tl-host" style={{ "--host-color": hostColor(host) }}>
      <div className="tl-host-head">
        <span className={`status-dot status-dot--${machine.online ? "ok" : "bad"}`} />
        <strong className="tl-name">{host}</strong>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!shells}
          title={shells ? `Root shell on ${host}` : off}
          onClick={() => terminal.open({ host, target: "host" })}
        >
          Host shell
        </button>
      </div>
      {running.length > 0 && (
        <div className="tl-container">
          <select className="tl-select" value={container?.id || ""} onChange={(e) => setPicked(e.target.value)} aria-label={`Container on ${host}`}>
            {running.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!shells}
            title={shells ? undefined : off}
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
        </div>
      )}
    </div>
  );
}

// God mode's Terminal tab: the servers down the left, each with a root shell
// and a shell / logs picker for its containers; the terminals fill the rest.
function TerminalTab({ machines, containers }) {
  const terminal = useTerminal();
  const fit = useFitHeight();
  const stage = useRef(null);
  const hosts = Object.keys(machines).sort();

  // The terminal dock is fixed to the window; pin it exactly over the stage.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const place = () => {
      const r = stage.current?.getBoundingClientRect();
      if (!r) return;
      root.style.setProperty("--term-full-top", `${Math.round(r.top)}px`);
      root.style.setProperty("--term-full-left", `${Math.round(r.left)}px`);
      root.style.setProperty("--term-full-right", `${Math.round(window.innerWidth - r.right)}px`);
      root.style.setProperty("--term-full-bottom", `${Math.round(window.innerHeight - r.bottom)}px`);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
      for (const k of ["top", "left", "right", "bottom"]) root.style.removeProperty(`--term-full-${k}`);
    };
  });

  return (
    <section className="terminal-tab" ref={fit}>
      <aside className="tl-side">
        {hosts.map((h) => (
          <HostLauncher key={h} host={h} machine={machines[h]} containers={containers[h]} />
        ))}
      </aside>
      <div className="tl-stage" ref={stage}>
        {!terminal?.count && (
          <p className="tl-empty">
            Open a host shell, or pick a container for a shell or its logs.
            <small>Terminals stay open when you switch tabs; logs open in any mode.</small>
          </p>
        )}
      </div>
    </section>
  );
}

export default TerminalTab;
