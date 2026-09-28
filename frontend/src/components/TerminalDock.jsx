import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { TerminalContext } from "./terminalContext";
import { useLocalStorage } from "./useLocalStorage";
import { hostColor } from "./hostColor";
import Icon from "./Icon";

const TerminalView = lazy(() => import("./TerminalView"));

const MIN_HEIGHT = 160;

// Shells live in a dock along the bottom of the page, outside the tabs, so
// switching from Containers to Servers doesn't kill the one you're in.
// Several at once, one per tab; the top edge drags to resize; the chevron
// folds it down to just the tab strip.
function TerminalDock({ machines, children }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [folded, setFolded] = useState(false);
  const [status, setStatus] = useState({});
  const [height, setHeight] = useLocalStorage("terminalHeight", 340);
  const nextId = useRef(1);

  const open = useCallback((spec) => {
    const id = nextId.current++;
    setSessions((current) => [...current, { ...spec, id }]);
    setActiveId(id);
    setFolded(false);
  }, []);

  const close = (id) => {
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (id === activeId) setActiveId(next.at(-1)?.id ?? null);
  };

  const available = useCallback(
    (host) => Boolean(machines?.[host]?.terminal),
    [machines]
  );
  const value = useMemo(() => ({ open, available }), [open, available]);

  const startDrag = (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (e) => {
      const max = window.innerHeight - 120;
      setHeight(Math.max(MIN_HEIGHT, Math.min(max, startHeight + startY - e.clientY)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <TerminalContext.Provider value={value}>
      {children}
      {sessions.length > 0 && (
        <>
          {/* Keeps the end of the page scrollable above the dock. */}
          <div style={{ height: folded ? 36 : height }} aria-hidden="true" />
          <section
            className={`term-dock ${folded ? "term-dock--folded" : ""}`}
            style={{ height: folded ? undefined : height }}
            aria-label="Terminals"
          >
            {!folded && <div className="term-grip" onPointerDown={startDrag} />}
            <div className="term-tabs" role="tablist">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  role="tab"
                  aria-selected={s.id === activeId}
                  className={`term-tab ${s.id === activeId ? "term-tab--active" : ""}`}
                  onClick={() => {
                    setActiveId(s.id);
                    setFolded(false);
                  }}
                  title={
                    s.target === "host"
                      ? `Shell on ${s.host}`
                      : s.target === "logs"
                        ? `Logs of ${s.name} on ${s.host}`
                        : `Shell in ${s.name} on ${s.host}`
                  }
                >
                  <span className={`term-dot term-dot--${status[s.id] || "connecting"}`} />
                  <span className="term-tab-name">
                    {s.target === "host" ? "host" : s.target === "logs" ? `logs · ${s.name}` : s.name}
                  </span>
                  <span className="term-tab-host" style={{ color: hostColor(s.host) }}>
                    {s.host}
                  </span>
                  {s.target === "logs" && (
                    <a
                      className="term-tab-close"
                      href={`/api/containers/${encodeURIComponent(s.host)}/${encodeURIComponent(s.container)}/logs/download`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Download the whole log"
                      title="Download the whole log"
                    >
                      ⤓
                    </a>
                  )}
                  <button
                    type="button"
                    className="term-tab-close"
                    aria-label="Close terminal"
                    title="Close (ends the shell)"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(s.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={`term-fold ${folded ? "term-fold--up" : ""}`}
                onClick={() => setFolded((f) => !f)}
                aria-label={folded ? "Show terminals" : "Fold terminals"}
                title={folded ? "Show" : "Fold"}
              >
                <Icon name="chevron" size={15} />
              </button>
            </div>
            <div className="term-body" hidden={folded}>
              <Suspense fallback={<div className="term-loading">Loading terminal…</div>}>
                {sessions.map((s) => (
                  <TerminalView
                    key={s.id}
                    session={s}
                    visible={!folded && s.id === activeId}
                    onStatus={(state) =>
                      setStatus((current) =>
                        current[s.id] === state ? current : { ...current, [s.id]: state }
                      )
                    }
                  />
                ))}
              </Suspense>
            </div>
          </section>
        </>
      )}
    </TerminalContext.Provider>
  );
}

export default TerminalDock;
