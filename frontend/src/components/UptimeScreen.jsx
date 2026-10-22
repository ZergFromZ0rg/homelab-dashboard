import { useRef, useState } from "react";
import "./network.css";
import CheckDetail from "./CheckDetail";
import CheckForm from "./CheckForm";
import CheckIncidents from "./CheckIncidents";
import CheckRow from "./CheckRow";
import CheckSuggestions from "./CheckSuggestions";
import { createCheck, fetchSuggestions, updateCheck } from "./checksApi";
import { arrange, checkTotals, isRootDown, worstCheck } from "./checkStatus";
import { formatLatency } from "./format";
import { useLocalStorage } from "./useLocalStorage";
import { useNow } from "./useNow";
import { usePolled } from "./usePolled";

// Down counts the root causes, like the tab's badge; what is behind one is shown
// with it, because that is how you read it.
const FILTERS = [
  ["all", "All", () => true, () => true],
  ["down", "Down", (c) => c.status === "down", isRootDown],
  ["slow", "Slow", (c) => c.status === "degraded", (c) => c.status === "degraded"],
  ["paused", "Paused", (c) => c.status === "paused", (c) => c.status === "paused"],
];

function PaneHead({ title, onClose }) {
  return (
    <div className="up-pane-head">
      <h3>{title}</h3>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
        ×
      </button>
    </div>
  );
}

// The uptime checks as a tool: a list of them on the left, the one you pick on the
// right — its history, its figures, its actions, or the form to change it. The
// same pane shows the form for a new check, what nothing is watching yet and the
// week's downtime, so nothing opens in the middle of the list and pushes it down.
function UptimeScreen({ checks, connected, hosts = [], initialId = "" }) {
  const now = useNow(1000).getTime() / 1000;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(initialId);
  const [pane, setPane] = useState("check"); // check | add | edit | suggest | incidents
  const [collapsed, setCollapsed] = useLocalStorage("checkGroupsCollapsed", {});
  const list = useRef(null);
  const suggestions = usePolled(fetchSuggestions, "suggestions", 60_000);

  const items = suggestions.data?.suggestions ?? [];
  const totals = checkTotals(checks);
  const groupNames = [...new Set(checks.map((c) => c.group).filter(Boolean))].sort();

  const needle = query.trim().toLowerCase();
  const passes = FILTERS.find(([id]) => id === filter)[2];
  const shown = checks.filter(
    (c) => passes(c) && (!needle || [c.name, c.target, c.group, c.type].some((v) => (v || "").toLowerCase().includes(needle)))
  );
  const groups = arrange(shown);
  const grouped = groups.some((g) => g.name !== "");

  // The one you picked, or — so the pane is never empty — the worst.
  const current = checks.find((c) => c.id === selected) ?? worstCheck(checks);

  const pick = (id) => {
    setSelected(id);
    setPane("check");
  };

  // Arrow keys walk the list, selecting as they go.
  const onKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll(".up-row") ?? [])];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  };

  const refreshSuggestions = () => fetchSuggestions().then(suggestions.mutate).catch(() => {});

  return (
    <section className="up">
      <div className="up-bar">
        <input
          type="search"
          className="up-search"
          placeholder="Filter checks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter checks"
        />
        <div className="segmented segmented--filters" role="group" aria-label="Show">
          {FILTERS.map(([id, label, , count]) => {
            const n = checks.filter(count).length;
            const tone = id === "down" ? "bad" : id === "slow" ? "warn" : null;
            return (
              <button key={id} type="button" className={filter === id ? "active" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
                <span className={`seg-count ${tone && n > 0 ? `seg-count--${tone}` : ""}`}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="up-bar-end">
          <button
            type="button"
            className="up-chipbtn"
            aria-pressed={pane === "incidents"}
            title="Downtime episodes, newest first"
            onClick={() => setPane(pane === "incidents" ? "check" : "incidents")}
          >
            Incidents · 24 h <strong>{totals.incidents}</strong>
          </button>
          {items.length > 0 && (
            <button
              type="button"
              className="up-chipbtn"
              aria-pressed={pane === "suggest"}
              title="Hosts and containers nothing is checking yet"
              onClick={() => setPane(pane === "suggest" ? "check" : "suggest")}
            >
              <strong>{items.length}</strong> not monitored
            </button>
          )}
          <button type="button" className="btn" onClick={() => setPane("add")}>
            + Add check
          </button>
        </div>
      </div>

      <div className="up-split">
        <div className="up-list overview-card">
          {checks.length > 0 && (
            <div className="up-summary">
              <span>
                Answering <b>{totals.answering}/{totals.total}</b>
                {totals.slow > 0 && <small> · {totals.slow} slow</small>}
                {totals.behind > 0 && <small> · {totals.behind} behind a down check</small>}
              </span>
              {totals.typical != null && (
                <span title="The median of the checks' own medians, over 24 hours">
                  Typical <b>{formatLatency(totals.typical)}</b>
                </span>
              )}
              {totals.worst && (
                <span title="The worst 95th percentile over 24 hours: the number that shows a spike an average hides">
                  Slowest <b>{formatLatency(totals.worst.p95_ms_24h)}</b> <small>{totals.worst.name}</small>
                </span>
              )}
              {totals.uptime != null && (
                <span>
                  Uptime <b>{totals.uptime.toFixed(2)}%</b> <small>24 h</small>
                </span>
              )}
            </div>
          )}

          <div className="up-scroll" ref={list} onKeyDown={onKeyDown}>
            {checks.length === 0 ? (
              <div className="empty-state">
                {connected === false
                  ? "Connecting…"
                  : "No checks yet. Add one to see whether Jellyfin, your router, DNS or the internet are actually answering."}
              </div>
            ) : shown.length === 0 ? (
              <div className="empty-state">
                No checks match.{" "}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filter
                </button>
              </div>
            ) : (
              groups.map((group) => {
                const shut = grouped && Boolean(collapsed[group.name]) && !needle;
                return (
                  <div key={group.name} className="up-group">
                    {grouped && (
                      <button
                        type="button"
                        className="up-group-head"
                        aria-expanded={!shut}
                        onClick={() => setCollapsed({ ...collapsed, [group.name]: !shut })}
                      >
                        <span className="check-group-caret">{shut ? "▸" : "▾"}</span>
                        <strong>{group.name || "Other"}</strong>
                        <span className="check-group-count">{group.rows.length}</span>
                        {group.down > 0 && <span className="chip chip--bad">{group.down} down</span>}
                        {group.slow > 0 && <span className="chip chip--warn">{group.slow} slow</span>}
                      </button>
                    )}
                    {!shut &&
                      group.rows.map(({ check, depth }) => (
                        <CheckRow key={check.id} check={check} depth={depth} now={now} selected={pane === "check" && current?.id === check.id} onSelect={pick} />
                      ))}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <aside className="up-detail overview-card" aria-label="Check detail">
          {pane === "add" && (
            <>
              <PaneHead title="Add a check" onClose={() => setPane("check")} />
              <div className="up-pane-body">
                <CheckForm
                  others={checks}
                  groups={groupNames}
                  hosts={hosts}
                  onCancel={() => setPane("check")}
                  onSubmit={async (values) => {
                    const created = await createCheck(values);
                    pick(created?.id ?? current?.id);
                  }}
                />
              </div>
            </>
          )}

          {pane === "edit" && current && (
            <>
              <PaneHead title={`Edit ${current.name}`} onClose={() => setPane("check")} />
              <div className="up-pane-body">
                <CheckForm
                  check={current}
                  others={checks.filter((c) => c.id !== current.id)}
                  groups={groupNames}
                  hosts={hosts}
                  onCancel={() => setPane("check")}
                  onSubmit={async (values) => {
                    await updateCheck(current.id, values);
                    setPane("check");
                  }}
                />
              </div>
            </>
          )}

          {pane === "suggest" && (
            <>
              <PaneHead title="Not monitored yet" onClose={() => setPane("check")} />
              <div className="up-pane-body">
                <CheckSuggestions
                  items={items}
                  onDone={(all) => {
                    refreshSuggestions();
                    if (all) setPane("check");
                  }}
                />
              </div>
            </>
          )}

          {pane === "incidents" && (
            <>
              <PaneHead title="Downtime, last 7 days" onClose={() => setPane("check")} />
              <div className="up-pane-body">
                <CheckIncidents now={now} />
              </div>
            </>
          )}

          {pane === "check" &&
            (current ? (
              <div className="up-pane-body">
                <CheckDetail key={current.id} check={current} now={now} onEdit={() => setPane("edit")} />
              </div>
            ) : (
              <div className="empty-state">Add a check to see its history here.</div>
            ))}
        </aside>
      </div>
    </section>
  );
}

export default UptimeScreen;
