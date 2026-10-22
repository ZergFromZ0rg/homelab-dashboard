import { useEffect, useRef, useState } from "react";
import BlockingControl from "./BlockingControl";
import { IconButton } from "./Icon";
import Panel from "./Panel";
import ServiceList from "./ServiceList";
import Sparkline from "./Sparkline";
import { formatMoved, formatRate } from "./bandwidthApi";
import { checkTotals } from "./checkStatus";
import { formatAge, formatLatency } from "./format";
import { hostColor } from "./hostColor";
import { hasTraffic, needsAName, pairRows, portsSummary, topUsers } from "./networkSummary";
import { piholeState } from "./piholeApi";
import { fetchSpeedtest, latestQuiet, runSpeedtest } from "./speedtestApi";
import { formatLinkSpeed, formatMbps, speedHint, speedTone } from "./switchApi";
import { useNow } from "./useNow";

// The panels of the Network overview. Each one gets the result of its own poll
// ({ data, error, loading, mutate }) and says plainly what it has: the numbers,
// a muted line when its source is not connected or not answering, "Loading…"
// the first time. One source failing never blanks the window.

const DOT = { up: "ok", slow: "warn", down: "bad", none: "none" };

function Quiet({ children }) {
  return <p className="nh-quiet">{children}</p>;
}

// "21 Mbps" -> 21 with a small "Mbps" after it.
function Figure({ text, suffix = "" }) {
  const [number, ...unit] = String(text).split(" ");
  return (
    <>
      {number}
      {(unit.length > 0 || suffix) && <small>{[...unit, suffix].filter(Boolean).join(" ")}</small>}
    </>
  );
}

function Metric({ label, title, hero = false, sub, children, figure }) {
  return (
    <div className={`nh-metric ${hero ? "nh-metric--hero" : ""}`} title={title}>
      <span>{label}</span>
      <strong>{figure}</strong>
      {children}
      {sub && <em>{sub}</em>}
    </div>
  );
}

const speed1 = (mbps) => (mbps == null ? "—" : mbps >= 100 ? String(Math.round(mbps)) : mbps.toFixed(1));

// --- the internet -----------------------------------------------------------------

export function InternetPanel({ speed, bandwidth, onOpen }) {
  const now = useNow(15000);
  const [problem, setProblem] = useState("");
  const s = speed.data;
  const results = s?.results || [];
  const last = latestQuiet(results) || results[results.length - 1];
  const uplink = (bandwidth.data?.devices || []).find((d) => d.uplink && d.up);
  const link = s?.link_mbps;
  const failure = problem || s?.error?.message || "";
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  // Start a test and follow it to its end, so the result lands as soon as it is done.
  const run = async () => {
    try {
      let next = await runSpeedtest();
      speed.mutate(next);
      setProblem("");
      while (next.running && mounted.current) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        next = await fetchSpeedtest();
        if (mounted.current) speed.mutate(next);
      }
    } catch (e) {
      if (mounted.current) setProblem(e.message);
    }
  };

  const foot = s && (
    <>
      {s.running ? (
        <span>Testing…</span>
      ) : failure ? (
        <span className="nh-bad" title={failure}>{failure}</span>
      ) : last ? (
        <span title={new Date(last.at * 1000).toLocaleString()}>
          tested {formatAge(now.getTime() / 1000 - last.at)}
          {last.busy && (
            <span className="dev-tag dev-tag--warn" title="The line was in use during this test, so it reads low.">
              line busy
            </span>
          )}
        </span>
      ) : (
        <span>no test yet</span>
      )}
      <IconButton icon="play" label="Test now" className="nh-foot-end" working={s.running} onClick={run} />
    </>
  );

  return (
    <Panel title="Internet" linkLabel="Bandwidth" onLink={onOpen} className={`nh-internet ${hasTraffic(bandwidth.data) ? "net-grow" : "net-fixed"}`} foot={foot}>
      {!s ? (
        <Quiet>{speed.error ? "Couldn't ask the dashboard for the speed test." : "Loading…"}</Quiet>
      ) : (
        <div className="nh-metrics">
          <Metric
            hero
            label="Download"
            figure={<Figure text={last ? `${speed1(last.down_mbps)} Mbps` : "—"} />}
            title="Measured by the dashboard's host, against Cloudflare."
          />
          <Metric hero label="Upload" figure={<Figure text={last ? `${speed1(last.up_mbps)} Mbps` : "—"} />} title="Measured by the dashboard's host, against Cloudflare." />
          <Metric
            label="Latency"
            figure={<Figure text={last ? formatLatency(last.ping_ms) : "—"} />}
            sub={last ? `± ${formatLatency(last.jitter_ms)}` : undefined}
            title="Round trip to Cloudflare, and how much it varies from one echo to the next"
          />
          <Metric
            label={uplink?.wan ? "Internet now" : "In use now"}
            figure={uplink ? <Figure text={formatRate(uplink.down_bps)} suffix="↓" /> : "—"}
            sub={uplink ? `${formatRate(uplink.up_bps)} ↑${link ? ` · of ${link}M` : ""}` : undefined}
            title={
              uplink?.wan
                ? "The router's own counters for its internet link: everything, Wi-Fi included."
                : "What crosses the router's switch port right now. Wi-Fi devices on the router mostly don't cross it."
            }
          />
        </div>
      )}
      {s && uplink && uplink.down_trend?.length > 1 && <TrafficChart uplink={uplink} />}
    </Panel>
  );
}

// What crossed the internet link over the last two hours, download and upload on
// one scale, filling whatever height the column has left.
function TrafficChart({ uplink }) {
  const peak = Math.max(0, ...uplink.down_trend.map((p) => p.v ?? 0), ...(uplink.up_trend || []).map((p) => p.v ?? 0));
  const max = (peak || 1) * 1.15;
  return (
    <div className="nh-chart" title="What crossed the router's internet link over the last two hours">
      <div className="nh-chart-head">
        <span>Traffic · 2 h</span>
        <span className="nh-chart-key">
          <i className="nh-key nh-key--rx" /> down <i className="nh-key nh-key--tx" /> up
        </span>
      </div>
      <div className="nh-chart-plot">
        <Sparkline points={uplink.down_trend} variant="rx" height={60} max={max} />
        <Sparkline points={uplink.up_trend || []} variant="tx" height={60} max={max} />
      </div>
    </div>
  );
}

// --- who is using it --------------------------------------------------------------

export function UsagePanel({ bandwidth, hosts, onOpen }) {
  const snapshot = bandwidth.data;
  const grows = !hasTraffic(snapshot);
  const { rows, more, other, window } = topUsers(snapshot);
  const unconfigured = snapshot?.state === "unconfigured";

  let body;
  if (!snapshot) body = <Quiet>{bandwidth.error ? "Couldn't ask the dashboard about bandwidth." : "Loading…"}</Quiet>;
  else if (unconfigured) body = <Quiet>Bandwidth by device reads the switch. Prometheus needs a job named <code>switch</code> for it.</Quiet>;
  else if (rows.length === 0) body = <Quiet>{snapshot.state === "loading" ? "Loading…" : "The switch isn't reporting any ports right now."}</Quiet>;
  else {
    body = rows.map(({ device, share, moved }) => (
      <div
        key={device.index}
        className={`nh-row ${device.up ? "" : "nh-row--idle"}`}
        title={`${formatMoved(device.down_24h)} down, ${formatMoved(device.up_24h)} up in ${window}; now ${formatRate(device.down_bps)} down, ${formatRate(device.up_bps)} up`}
      >
        <span className="grow" style={hosts.includes(device.name) ? { color: hostColor(device.name) } : undefined}>
          <span className="nh-name">{device.name}</span>
        </span>
        <span className="nh-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(2, Math.round((share ?? 0) * 100))}%` }} />
        </span>
        <span className="num nh-moved">{formatMoved(moved)}</span>
      </div>
    ));
  }

  const foot =
    rows.length > 0 && (other || more > 0) ? (
      <>
        {other && (
          <span title="The router's internet download minus what it passed to the switch: Wi-Fi devices and anything else on the router itself.">
            Wi-Fi and other · {formatMoved(other.moved)} ↓
          </span>
        )}
        {more > 0 && <span className="nh-foot-end">+{more} more</span>}
      </>
    ) : undefined;

  return (
    <Panel title="Who's using it" count={window} linkLabel="Bandwidth" onLink={onOpen} className={grows ? "net-grow" : "net-fixed"} foot={foot}>
      {body}
    </Panel>
  );
}

// --- uptime ------------------------------------------------------------------------

export function UptimePanel({ checks, onOpenCheck, onOpen }) {
  const t = checkTotals(checks);
  const foot = checks.length > 0 && (
    <span
      className="nh-ellipsis"
      title={`Typical is the median of the checks' own medians; slowest is the worst 95th percentile. Over 24 hours.`}
    >
      {[
        t.typical != null && `typical ${formatLatency(t.typical)}`,
        t.worst && `slowest ${formatLatency(t.worst.p95_ms_24h)} (${t.worst.name})`,
        t.uptime != null && `${t.uptime.toFixed(2)}% up`,
        t.incidents > 0 && `${t.incidents} incident${t.incidents === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ")}
    </span>
  );

  return (
    <Panel
      title="Uptime"
      count={checks.length ? `${t.answering}/${t.total}` : null}
      tone={t.down ? "bad" : t.slow ? "warn" : undefined}
      linkLabel="Open"
      onLink={onOpen}
      className="net-grow"
      foot={foot || undefined}
    >
      {checks.length === 0 ? (
        <Quiet>No checks yet. Add some under Uptime to see whether your services, router, DNS and the internet are answering.</Quiet>
      ) : (
        <ServiceList checks={checks} onOpen={(c) => onOpenCheck(c.id)} />
      )}
    </Panel>
  );
}

// --- between hosts -----------------------------------------------------------------

export function LinksPanel({ matrix, onOpenCheck }) {
  const rows = pairRows(matrix.data);
  if (rows.length === 0) return null;
  const tone = rows.some((r) => r.state === "down") ? "bad" : rows.some((r) => r.state === "slow") ? "warn" : undefined;

  return (
    <Panel title="Between hosts" tone={tone} className="net-fixed">
      {rows.map(({ cell, state }) => {
        const title = [
          `${cell.from} → ${cell.to}`,
          cell.status === "down" ? cell.detail : null,
          cell.loss_pct_3h != null ? `loss ${cell.loss_pct_3h}% · jitter ${formatLatency(cell.jitter_ms_3h)} · 3 h` : null,
          cell.p95_ms_24h != null ? `p95 ${formatLatency(cell.p95_ms_24h)} · 24 h` : null,
          cell.uptime_24h != null ? `${cell.uptime_24h.toFixed(2)}% up · 24 h` : null,
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <button key={`${cell.from}>${cell.to}`} type="button" className={`nh-row nh-row--${state}`} title={title} onClick={() => onOpenCheck(cell.id)}>
            <span className={`status-dot status-dot--${DOT[state]}`} />
            <span className="grow">
              <b style={{ color: hostColor(cell.from) }}>{cell.from}</b> → <b style={{ color: hostColor(cell.to) }}>{cell.to}</b>
            </span>
            <span className="num nh-latency">{cell.status === "down" ? "down" : formatLatency(cell.latency_ms)}</span>
            <span className="num dim nh-loss">{cell.loss_pct_3h != null ? `${cell.loss_pct_3h}% loss` : ""}</span>
          </button>
        );
      })}
    </Panel>
  );
}

// --- DNS ----------------------------------------------------------------------------

const DNS_STATE = { up: ["ok", "up"], stale: ["warn", "stale"], unreachable: ["bad", "unreachable"], down: ["bad", "unreachable"] };
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function DnsPanel({ pihole, devices, onOpen }) {
  const now = useNow(1000);
  const snapshot = pihole.data;
  const state = snapshot ? piholeState(snapshot) : null;
  const named = needsAName(devices.data?.devices);

  let body;
  if (!snapshot) body = <Quiet>{pihole.error ? "Couldn't ask the dashboard about Pi-hole." : "Loading…"}</Quiet>;
  else if (state === "unconfigured") {
    body = (
      <Quiet>
        Pi-hole isn't connected. Set <code>PIHOLE_URL</code> and <code>PIHOLE_APP_PASSWORD</code> in the dashboard's <code>.env</code>.
      </Quiet>
    );
  } else {
    const [tone, label] = DNS_STATE[state] || DNS_STATE.down;
    const { summary } = snapshot;
    body = (
      <>
        <div className="nh-line">
          <span className={`status-dot status-dot--${tone}`} />
          <span className="nh-state">Pi-hole {label}</span>
          {snapshot.blocking && state !== "down" && (
            <BlockingControl snapshot={snapshot} now={now} onChange={pihole.mutate} />
          )}
        </div>
        {summary ? (
          <div className="nh-metrics nh-metrics--row">
            <Metric label="Queries" figure={summary.total.toLocaleString()} title="DNS queries Pi-hole answered today" />
            <Metric label="Blocked" figure={`${summary.percent_blocked}%`} title={`${summary.blocked.toLocaleString()} queries blocked today`} />
            <Metric label="Devices" figure={summary.active_clients} title="Devices that asked Pi-hole for DNS today" />
            <Metric label="Blocklist" figure={compact.format(summary.gravity_domains)} title={`${summary.gravity_domains.toLocaleString()} domains on Pi-hole's blocklists`} />
          </div>
        ) : (
          <Quiet>No numbers yet — waiting for the first successful poll.</Quiet>
        )}
        {named.total > 0 && (
          <>
            <div className="nh-sub">Needs a name · {named.total}</div>
            {named.rows.map((d) => (
              <button key={d.mac} type="button" className="nh-row" onClick={onOpen} title={`${d.vendor || "Unknown maker"} · ${d.ip || "no address"} — open DNS to name it`}>
                <span className="status-dot status-dot--warn" />
                <span className="grow"><span className="nh-name">{d.name}</span></span>
                <span className="dev-tag dev-tag--warn">{d.new ? "new" : d.private_mac ? "private MAC" : "unnamed"}</span>
              </button>
            ))}
            {named.total > named.rows.length && <div className="nh-more">+{named.total - named.rows.length} more</div>}
          </>
        )}
      </>
    );
  }

  return (
    <Panel title="DNS" linkLabel="Devices" onLink={onOpen} className="net-fixed">
      {body}
    </Panel>
  );
}

// --- the switch ---------------------------------------------------------------------

export function PortsPanel({ sw, hosts }) {
  const now = useNow(15000);
  const snapshot = sw.data;
  const ports = snapshot?.ports || [];
  const sum = portsSummary(ports);
  const configured = snapshot && snapshot.state !== "unconfigured";

  let body;
  if (!snapshot) body = <Quiet>{sw.error ? "Couldn't ask the dashboard about the switch." : "Loading…"}</Quiet>;
  else if (!configured) {
    body = (
      <Quiet>
        Prometheus has no job named <code>switch</code>. Run snmp_exporter against the switch and add a scrape job with that name (<code>SWITCH_JOB</code> in the
        dashboard's <code>.env</code> changes it).
      </Quiet>
    );
  } else {
    body = (
      <>
        {snapshot.state === "down" && (
          <Quiet>
            Prometheus can't read the switch. Check its power, then <code>docker logs snmp-exporter</code> on bigboy.
          </Quiet>
        )}
        {ports.length === 0 && snapshot.state === "up" && <Quiet>The switch isn't reporting any ports.</Quiet>}
        {ports.map((p) => {
          const tone = speedTone(p);
          return (
            <div key={p.index} className={`nh-row nh-port ${p.up ? "" : "nh-row--idle"}`} title={`Port ${p.port}${p.up ? "" : " — no link"}`}>
              <span className={`status-dot status-dot--${p.up ? "ok" : "bad"}`} />
              <span className="grow" style={hosts.includes(p.name) ? { color: hostColor(p.name) } : undefined}>
                <span className="nh-name">{p.name}</span>
                {!p.labelled && (
                  <span className="dev-tag dev-tag--warn" title="Something is plugged in but the port has no description on the switch">
                    no label
                  </span>
                )}
                {p.errors_24h > 0 && (
                  <span className="dev-tag dev-tag--warn" title="Damaged packets, in and out, over the last 24 hours">
                    {p.errors_24h} err
                  </span>
                )}
              </span>
              <span className={`num nh-speed ${tone ? `nh-speed--${tone}` : ""} ${p.up ? "" : "nh-speed--none"}`} title={speedHint(p)}>
                {p.up ? formatLinkSpeed(p.speed_mbps) : "no link"}
              </span>
              <span className="num nh-rate" title="Traffic the switch is sending to the device, in Mbps">
                {p.up ? `${formatMbps(p.received_bps)}↓` : ""}
              </span>
              <span className="num nh-rate" title="Traffic the device is sending to the switch, in Mbps">
                {p.up ? `${formatMbps(p.sent_bps)}↑` : ""}
              </span>
            </div>
          );
        })}
      </>
    );
  }

  const foot =
    configured && snapshot.instance ? (
      <>
        <span className="mono">{snapshot.instance}</span>
        {snapshot.stale && snapshot.updated_at && <span className="nh-foot-end">last ports it returned, {formatAge(now.getTime() / 1000 - snapshot.updated_at)}</span>}
      </>
    ) : undefined;

  return (
    <Panel
      title="Switch"
      count={configured && sum.total ? `${sum.up}/${sum.total} up` : null}
      tone={sum.down > 0 ? "warn" : undefined}
      className="net-grow"
      foot={foot}
    >
      {body}
    </Panel>
  );
}
