import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { containerUrl } from "./containerLink";
import { hostColor } from "./hostColor";
import { useTerminal } from "./terminalContext";
import { useUpdates } from "./updatesContext";
import { requestFocus } from "./focusRequest";

// ⌘K / Ctrl+K: jump anywhere, do the common things. Every tab, every host
// (show it, its files, a shell), every container (find it, open its web
// UI, a shell, its settings, restart, update). Words match anywhere, in any
// order; titles that start with what you typed come first. Arrows + Enter.

function score(item, words) {
  const hay = item.search;
  if (!words.every((w) => hay.includes(w))) return -1;
  const title = item.title.toLowerCase();
  return (title.startsWith(words[0]) ? 100 : 0) + (title.includes(words.join(" ")) ? 50 : 0) - item.rank;
}

function buildItems({ tabs, machines, containers, go, openSettings, terminal, updates, control }) {
  const items = [];
  const add = (kind, title, sub, run, { keywords = "", rank = 0, host } = {}) =>
    items.push({ kind, title, sub, run, host, rank, search: `${kind} ${title} ${sub ?? ""} ${keywords}`.toLowerCase() });

  tabs.forEach((t) => add("tab", t.label, "Go to tab", () => go({ tab: t.value }), { rank: 0 }));
  add("action", "Settings", "Dashboard settings drawer", () => go({ tab: "settings" }), { rank: 1 });

  Object.keys(machines).sort().forEach((host) => {
    add("host", host, "Show on Servers", () => go({ tab: "servers", host }), { host, rank: 1, keywords: "server machine" });
    add("host", `Files on ${host}`, "Browse files", () => go({ tab: "servers", host, action: "files" }), { host, rank: 3, keywords: "browse disk explorer folder" });
    if (terminal?.available(host)) {
      add("host", `Shell on ${host}`, "Host terminal", () => terminal.open({ host, target: "host" }), { host, rank: 3, keywords: "terminal ssh console" });
    }
    const updatable = (containers[host] || []).filter((c) => c.update?.can_update);
    if (updatable.length) {
      add("host", `Update all on ${host}`, `${updatable.length} newer image${updatable.length === 1 ? "" : "s"}`, () => {
        if (window.confirm(`Update ${updatable.map((c) => c.name).join(", ")} on ${host}?`)) {
          updates.start(host, updatable.map((c) => c.name));
          go({ tab: "containers" });
        }
      }, { host, rank: 4, keywords: "upgrade pull images" });
    }
  });

  Object.entries(containers).forEach(([host, list]) => {
    list.forEach((c) => {
      const running = c.status === "running";
      const k = { host, rank: 2, keywords: `container ${c.image ?? ""} ${c.compose_project ?? ""}` };
      add("container", c.name, `${host} · ${c.status}`, () => go({ tab: "containers", container: c.name }), k);
      const url = containerUrl(host, c.ports);
      if (url) add("container", `Open ${c.name}`, url, () => window.open(url, "_blank", "noopener"), { ...k, rank: 3, keywords: `${k.keywords} web ui browser` });
      if (running && terminal?.available(host)) {
        add("container", `Shell in ${c.name}`, host, () => terminal.open({ host, target: "container", container: c.id, name: c.name }), { ...k, rank: 4, keywords: `${k.keywords} terminal exec console` });
      }
      add("container", `Settings for ${c.name}`, "Compose file", () => openSettings(host, c), { ...k, rank: 4, keywords: `${k.keywords} compose yaml env ports volumes` });
      if (!c.protected) {
        add("container", `Restart ${c.name}`, host, () => {
          if (window.confirm(`Restart ${c.name} on ${host}?`)) control.run(host, c.id, "restart");
        }, { ...k, rank: 5 });
      }
      if (c.update?.can_update) {
        add("container", `Update ${c.name}`, "Newer image available", () => {
          if (window.confirm(`Update ${c.name} on ${host}?`)) updates.start(host, [c.name]);
        }, { ...k, rank: 4, keywords: `${k.keywords} upgrade pull image` });
      }
    });
  });
  return items;
}

const KIND_LABEL = { tab: "Tab", host: "Host", container: "Container", action: "Action" };

function CommandPalette({ tabs, machines, containers, control, onNavigate, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const terminal = useTerminal();
  const updates = useUpdates();
  const list = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
      }
    };
    const onOpen = () => {
      setOpen(true);
      setQuery("");
      setActive(0);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("homelab:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("homelab:open-palette", onOpen);
    };
  }, []);

  const go = ({ tab, host, action, container }) => {
    if (tab === "settings") return onNavigate("settings");
    onNavigate(tab, { container });
    if (host) requestFocus(host, action === "files" ? "files" : "show");
  };

  const items = useMemo(
    () => (open ? buildItems({ tabs, machines, containers, go, openSettings: onOpenSettings, terminal, updates, control }) : []),
    // `go` is recreated per render but only closes over stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, tabs, machines, containers, terminal, updates, control, onOpenSettings]
  );

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items.filter((i) => i.kind === "tab" || i.kind === "action" || (i.kind === "host" && i.rank === 1));
    return items
      .map((item) => ({ item, s: score(item, words) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.item);
  }, [items, query]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (item) => {
    setOpen(false);
    item?.run();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  };

  return createPortal(
    <div className="palette-root" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Jump to a host, container or tab — or run an action…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Search commands"
          spellCheck={false}
        />
        <ul className="palette-list" role="listbox" ref={list}>
          {results.map((item, i) => (
            <li
              key={`${item.kind}-${item.title}-${item.host ?? ""}`}
              role="option"
              aria-selected={i === active}
              className={`palette-item ${i === active ? "palette-item--on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(item)}
            >
              <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
              <span className="palette-title">{item.title}</span>
              <span className="palette-sub" style={item.host ? { color: hostColor(item.host) } : undefined}>
                {item.sub}
              </span>
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">Nothing matches.</li>}
        </ul>
        <div className="palette-foot">↑↓ to move · Enter to run · Esc to close</div>
      </div>
    </div>,
    document.body
  );
}

export default CommandPalette;
