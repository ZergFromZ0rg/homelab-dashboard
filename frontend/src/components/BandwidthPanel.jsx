import { useCallback, useEffect, useState } from "react";
import Sparkline from "./Sparkline";
import { IconButton } from "./Icon";
import { useNow } from "./useNow";
import { formatAge, formatDuration, formatLatency } from "./format";
import { BANDWIDTH_RANGES, fetchBandwidth, formatMoved, formatRate, orderDevices, shareOfDay } from "./bandwidthApi";
import { useLocalStorage } from "./useLocalStorage";
import { fetchSpeedtest, history, latestQuiet, runSpeedtest, scheduleLabel, setSpeedtestSchedule } from "./speedtestApi";

// Bandwidth: how fast the internet is (a test the dashboard runs on a schedule)
// and who is using the network (each switch port is a device meter). Wi-Fi
// devices sit behind the router, so they are one row, the router's, and say so.

const POLL_MS = 15000;
const TESTING_POLL_MS = 2000;

function usePoll(fetcher, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await fetcher());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [fetcher]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, intervalMs]);
  return [data, setData, error];
}

const mbps = (value) => (value == null ? "—" : `${value >= 100 ? Math.round(value) : value.toFixed(1)} Mbps`);

function Internet({ speed, setSpeed, uplink, readOnly, now }) {
  const [problem, setProblem] = useState("");
  const results = speed.results || [];
  const last = latestQuiet(results) || results[results.length - 1];
  const age = last ? formatAge(now.getTime() / 1000 - last.at) : null;
  const link = speed.link_mbps;

  const act = async (action) => {
    try {
      setSpeed(await action());
      setProblem("");
    } catch (e) {
      setProblem(e.message);
    }
  };

  const error = problem || (speed.error ? speed.error.message : "");
  const downHint = link && last && last.down_mbps >= link * 0.9
    ? `Measured by the dashboard's host. The router's switch port runs at ${link} Mbps, so a faster line would still read about this.`
    : "Measured by the dashboard's host, against Cloudflare.";

  return (
    <div className="bw-net">
      <div className="bw-head">
        <span className={`status-dot status-dot--${speed.running ? "warn" : error ? "bad" : "ok"}`} />
        <strong>Internet</strong>
        {speed.running ? (
          <span className="bw-state">Testing…</span>
        ) : error ? (
          <span className="bw-state bw-state--bad" title={error}>{error}</span>
        ) : last ? (
          <span className="net-dim" title={new Date(last.at * 1000).toLocaleString()}>
            tested {age}
            {last.busy && <span className="dev-tag dev-tag--warn" title="The line was in use during this test, so it reads low. It is left out of what counts as usual.">line busy</span>}
          </span>
        ) : (
          <span className="net-dim">the first test runs a minute after the dashboard starts</span>
        )}
        {!readOnly && (
          <span className="bw-controls">
            <select
              aria-label="Test schedule"
              value={speed.every_hours}
              title="How often a test runs. A test waits while the line is in use."
              onChange={(e) => act(() => setSpeedtestSchedule(Number(e.target.value)))}
            >
              {speed.choices.map((h) => (
                <option key={h} value={h}>{scheduleLabel(h)}</option>
              ))}
            </select>
            <IconButton
              icon="play"
              label="Test now"
              working={speed.running}
              onClick={() => act(runSpeedtest)}
            />
          </span>
        )}
      </div>

      <div className="pihole-tiles bw-tiles">
        <div title={downHint}>
          <span>Download</span>
          <strong>{last ? mbps(last.down_mbps) : "—"}</strong>
          <Sparkline points={history(results, "down_mbps")} variant="rx" height={16} />
        </div>
        <div title="Measured by the dashboard's host, against Cloudflare.">
          <span>Upload</span>
          <strong>{last ? mbps(last.up_mbps) : "—"}</strong>
          <Sparkline points={history(results, "up_mbps")} variant="tx" height={16} />
        </div>
        <div title="Round trip to Cloudflare, and how much it varies from one echo to the next">
          <span>Latency</span>
          <strong>{last ? formatLatency(last.ping_ms) : "—"}</strong>
          <small>{last ? `± ${formatLatency(last.jitter_ms)}` : ""}</small>
        </div>
        <div title={uplink?.wan
          ? `The router's own counters for its internet link${link ? `, of its ${link} Mbps` : ""}: everything, Wi-Fi included.`
          : `What crosses the router's switch port right now${link ? `, of its ${link} Mbps link` : ""}. Wi-Fi devices on the router itself mostly don't cross it, so this is not the whole household.`}>
          <span>{uplink?.wan ? "Internet now" : "In use now"}</span>
          <strong>{uplink ? `${formatRate(uplink.down_bps)} ↓` : "—"}</strong>
          <small>{uplink ? `${formatRate(uplink.up_bps)} ↑${link ? ` · of ${link}M` : ""}` : ""}</small>
        </div>
      </div>
    </div>
  );
}

function Device({ device, devices }) {
  const share = shareOfDay(device, devices);
  const partial = device.totals_partial
    ? `The router's counters have been read for ${formatDuration(device.covers_seconds)} so far, so this total covers that long, not the whole range.`
    : undefined;
  return (
    <tr className={device.up ? "" : "sw-row--down"}>
      <td>
        <span className={`status-dot status-dot--${device.up ? "ok" : "bad"}`} title={device.up ? "Link up" : "No link"} />
      </td>
      <td>
        <span className="dev-name">{device.name}</span>
        {device.wan && (
          <span
            className="dev-tag"
            title="The router's own counters for its internet connection: everything going out or coming in, Wi-Fi devices included. The switch can't see Wi-Fi devices, because they are routed out of the router and never touch it."
          >
            router WAN
          </span>
        )}
        {device.uplink && !device.wan && (
          <span
            className="dev-tag"
            title="The router's side of the switch: the internet traffic of the devices above, plus what passes between them and the router's Wi-Fi devices. A Wi-Fi device's own internet traffic goes straight out of the router and never crosses the switch, so it is not counted here."
          >
            router link
          </span>
        )}
        {device.derived && (
          <span
            className="dev-tag"
            title="The router's internet download minus what it passed to the switch: Wi-Fi devices and anything else on the router itself. Not measured directly. Upload isn't shown: LAN traffic to Wi-Fi devices crosses the same port, so the two can't be told apart."
          >
            derived
          </span>
        )}
        {!device.labelled && (
          <span className="dev-tag dev-tag--warn" title="Something is plugged in but the port has no description on the switch (Switching → Ports → Description)">
            no label
          </span>
        )}
      </td>
      <td className="pcap-r net-mono">{device.up ? formatRate(device.down_bps) : "—"}</td>
      <td className="bw-spark"><Sparkline points={device.down_trend} variant="rx" height={16} /></td>
      <td className="pcap-r net-mono">{device.up ? formatRate(device.up_bps) : "—"}</td>
      <td className="bw-spark"><Sparkline points={device.up_trend} variant="tx" height={16} /></td>
      <td className="pcap-r net-mono" title={partial}>{formatMoved(device.down_24h)}</td>
      <td className="pcap-r net-mono" title={partial}>{formatMoved(device.up_24h)}</td>
      <td className="bw-share" title={share != null ? `${Math.round(share * 100)}% of what the devices moved in 24 hours` : undefined}>
        {share != null && (
          <>
            <span className="bw-bar"><span style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} /></span>
            <span className="net-mono net-dim">{Math.round(share * 100)}%</span>
          </>
        )}
      </td>
    </tr>
  );
}

function Devices({ snapshot, range, setRange }) {
  if (snapshot.state === "unconfigured") {
    return (
      <p className="lan-empty">
        Bandwidth by device reads the switch. Set it up under Network → Switch first (Prometheus needs a job named{" "}
        <code>switch</code>).
      </p>
    );
  }
  const devices = orderDevices(snapshot.devices || []);
  const window = snapshot.totals_window || "24h";
  if (devices.length === 0) {
    return <p className="lan-empty">{snapshot.state === "loading" ? "Loading…" : "The switch isn't reporting any ports right now."}</p>;
  }
  return (
    <>
    <div className="bw-range">
      <div className="segmented segmented--sm" role="group" aria-label="Trend range">
        {BANDWIDTH_RANGES.map((r) => (
          <button key={r} type="button" className={range === r ? "active" : ""} aria-pressed={range === r} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>
      <span className="net-dim">trend and totals over the range; totals are never under a day</span>
    </div>
    <div className="lan-scroll">
      <table className="net-table lan-table bw-table">
        <thead>
          <tr>
            <th aria-label="Link" />
            <th>Device</th>
            <th className="pcap-r" title="Traffic the switch is sending to the device (for the router: from the internet)">Down</th>
            <th aria-label="Download, last 2 hours" />
            <th className="pcap-r" title="Traffic the device is sending to the switch (for the router: to the internet)">Up</th>
            <th aria-label="Upload, last 2 hours" />
            <th className="pcap-r" title={`Moved to the device in the last ${window}`}>Down {window}</th>
            <th className="pcap-r" title={`Moved from the device in the last ${window}`}>Up {window}</th>
            <th title={`Share of everything the devices moved in ${window}`}>Share</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <Device key={device.index} device={device} devices={devices} />
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function BandwidthPanel({ readOnly = false }) {
  const [speed, setSpeed, speedError] = usePoll(fetchSpeedtest, POLL_MS);
  const [range, setRange] = useLocalStorage("bandwidthRange", "2h");
  const chosen = BANDWIDTH_RANGES.includes(range) ? range : "2h";
  const fetchRange = useCallback(() => fetchBandwidth(chosen), [chosen]);
  const [bandwidth, , bandwidthError] = usePoll(fetchRange, POLL_MS);
  const now = useNow(15000);
  const testing = speed?.running;

  // A running test is polled closely so its result lands as soon as it's done.
  useEffect(() => {
    if (!testing) return undefined;
    const timer = setInterval(async () => {
      try {
        setSpeed(await fetchSpeedtest());
      } catch {
        /* the slow poll will report it */
      }
    }, TESTING_POLL_MS);
    return () => clearInterval(timer);
  }, [testing, setSpeed]);

  if (!speed && !bandwidth) {
    const error = speedError || bandwidthError;
    return <p className="lan-empty">{error ? `Couldn't ask the dashboard about bandwidth: ${error}` : "Loading…"}</p>;
  }

  const uplink = (bandwidth?.devices || []).find((d) => d.uplink && d.up);

  return (
    <div className="bw">
      {speed && <Internet speed={speed} setSpeed={setSpeed} uplink={uplink} readOnly={readOnly} now={now} />}
      {bandwidth ? <Devices snapshot={bandwidth} range={chosen} setRange={setRange} /> : <p className="lan-empty">{bandwidthError || "Loading…"}</p>}
    </div>
  );
}

export default BandwidthPanel;
