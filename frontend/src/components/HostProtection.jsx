import Panel from "./Panel";
import { formatBytes } from "./format";
import { hostColor } from "./hostColor";
import { protection } from "./recovery";

const SHOWN = 3;
const RANK = { bad: 0, warn: 1, none: 2, ok: 3 };

function HostBlock({ host, p, error, onRecover }) {
  const stacks = p.stacks;
  const detail = p.config.state === "not_configured" ? "" : p.config.detail;

  let data;
  if (p.failed) data = <span className="bk-tone--none" title={error}>Couldn't ask {host}</span>;
  else if (!p.known) data = <span className="bk-tone--none">Looking…</span>;
  else if (stacks.length > 0) {
    data = <span className="bk-tone--bad">{stacks.length} stack{stacks.length === 1 ? "" : "s"} not backed up</span>;
  } else {
    data = (
      <span className="bk-tone--ok">
        All backed up
        {p.ignored > 0 && <small>{p.ignored} skipped on purpose</small>}
      </span>
    );
  }

  return (
    <section className="bk-host">
      <header className="bk-host-head">
        <span className={`status-dot status-dot--${p.tone}`} />
        <strong style={{ color: hostColor(host) }}>{host}</strong>
        <span className={`bk-verdict bk-verdict--${p.tone}`}>{p.label}</span>
        <button type="button" className="bk-link" onClick={() => onRecover(host)} title={`Open ${host}'s Maintenance page, where its recovery is managed`}>
          Recover →
        </button>
      </header>

      <dl className="bk-lines">
        <div className="bk-line">
          <dt>Compose files</dt>
          <dd className={`bk-tone--${p.config.tone}`} title={p.config.detail || undefined}>
            {p.config.word}
            {detail && <small>{detail}</small>}
          </dd>
        </div>
        <div className="bk-line">
          <dt>Data</dt>
          <dd>{data}</dd>
        </div>
      </dl>

      {stacks.length > 0 && (
        <ul className="bk-stacks">
          {stacks.slice(0, SHOWN).map((stack) => (
            <li key={stack.project}>
              <button type="button" className="bk-stack" onClick={() => onRecover(host)} title="Not backed up. Open its recovery to back it up or skip it.">
                <span className="grow">{stack.project}</span>
                <span className="num">
                  {formatBytes(stack.bytes)}
                  {stack.partial ? "+" : ""}
                </span>
              </button>
            </li>
          ))}
          {stacks.length > SHOWN && <li className="bk-more">+{stacks.length - SHOWN} more</li>}
        </ul>
      )}
    </section>
  );
}

// "If a host died", for every host: can you rebuild it (its compose files are pushed
// somewhere) and what would you lose (data no backup job covers). The compose-file
// state comes with every update; the data comes from each agent's recovery report
// and fills in as they answer. The way to fix it is that host's Maintenance page.
function HostProtection({ hosts, machines, recoveries, onRecover, className = "" }) {
  const rows = hosts
    .map((host) => {
      const entry = recoveries[host];
      return { host, error: entry?.error, p: protection({ backup: machines[host]?.backup, recovery: entry?.data ?? null, failed: Boolean(entry?.error) }) };
    })
    .sort((a, b) => RANK[a.p.tone] - RANK[b.p.tone] || a.host.localeCompare(b.host));
  const atRisk = rows.filter((r) => r.p.tone === "bad").length;

  return (
    <Panel
      title="If a host died"
      hint="What you could rebuild it from, and what you would lose"
      count={atRisk ? `${atRisk} at risk` : null}
      tone={atRisk ? "bad" : undefined}
      className={className}
    >
      {rows.length === 0 ? (
        <p className="bk-quiet">No servers reporting yet.</p>
      ) : (
        rows.map(({ host, p, error }) => <HostBlock key={host} host={host} p={p} error={error} onRecover={onRecover} />)
      )}
    </Panel>
  );
}

export default HostProtection;
