import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AUTH_REQUIRED_EVENT } from "./apiAuth";

// One shell: an xterm wired to /ws/terminal/{host}. Binary frames are
// terminal bytes both ways; text frames are JSON control (resize out;
// exit / error in). A shell can't be resumed once its socket drops, so
// "reconnect" means a fresh one — offered in the terminal itself, on Enter,
// with the old scrollback left above it.
//
// Lazy-loaded by TerminalDock: xterm is the heaviest thing on the page and
// most visits never open a shell.

const THEME = {
  background: "#0b0e14",
  foreground: "#e9ecf2",
  cursor: "#2dd4bf",
  selectionBackground: "rgba(45, 212, 191, 0.3)",
  black: "#1b212d",
  brightBlack: "#6b748a",
};

function socketUrl(session, term) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    target: session.target,
    cols: term.cols,
    rows: term.rows,
  });
  if (session.container) query.set("container", session.container);
  if (session.name) query.set("name", session.name);
  return `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(
    session.host
  )}?${query}`;
}

function TerminalView({ session, visible, onStatus }) {
  const holder = useRef(null);
  const fitRef = useRef(null);
  const statusRef = useRef(onStatus);

  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: styles.getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(holder.current);
    fit.fit();

    const encoder = new TextEncoder();
    let ws = null;
    let state = "connecting"; // connecting | open | ended
    let disposed = false;

    const setState = (next) => {
      state = next;
      statusRef.current?.(next);
    };

    const note = (text, tone = "2") => {
      // Dim (2) for status lines, red (31) for errors.
      term.write(`\r\n\x1b[${tone}m${text}\x1b[0m\r\n`);
    };

    function connect() {
      setState("connecting");
      let opened = false;
      let ended = false;
      ws = new WebSocket(socketUrl(session, term));
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        opened = true;
        setState("open");
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          term.write(new Uint8Array(event.data));
          return;
        }
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "exit") {
          ended = true;
          note(
            `[exited${message.code != null ? ` with code ${message.code}` : ""} — Enter for a new shell]`
          );
        } else if (message.type === "error") {
          ended = true;
          note(message.message, "31");
          note("[Enter to try again]");
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        if (!opened || event.code === 4401) {
          window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
        }
        if (!ended) note("[connection lost — Enter to reconnect]");
        setState("ended");
      };
    }

    const send = (payload) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
    };

    const dataSub = term.onData((data) => {
      if (state === "ended") {
        if (data === "\r") connect();
        return;
      }
      send(encoder.encode(data));
    });
    const binarySub = term.onBinary((data) => {
      send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      send(JSON.stringify({ type: "resize", cols, rows }));
    });

    // Ctrl+Shift+C copies on Linux/Windows, where plain Ctrl+C is SIGINT.
    // (Cmd+C / Cmd+V on a Mac and Ctrl+Shift+V everywhere already work: they
    // arrive as the browser's own copy and paste events.)
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyC"
      ) {
        const selection = term.getSelection();
        if (selection) navigator.clipboard?.writeText(selection).catch(() => {});
        return false;
      }
      return true;
    });

    const observer = new ResizeObserver(() => {
      if (holder.current?.offsetParent) fit.fit();
    });
    observer.observe(holder.current);

    connect();
    term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      resizeSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit();
      holder.current?.querySelector("textarea")?.focus();
    }
  }, [visible]);

  return <div className="term-view" ref={holder} hidden={!visible} />;
}

export default TerminalView;
