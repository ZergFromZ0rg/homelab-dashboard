# Bandwidth and internet speed

Network → Bandwidth answers two questions: how fast is the internet, and who is using the network.

## Internet speed

The dashboard's own host downloads and uploads for a few seconds against Cloudflare's
speed endpoints and keeps the result in `/data/speedtest.json`. Nothing to install.

- Runs every 6 hours by default; the picker in God mode sets Off / 1 / 3 / 6 / 12 / 24 h
  (`SPEEDTEST_EVERY_HOURS` sets the first default). The play button runs one now.
- A scheduled test **waits while the uplink is in use** (over 25% of its link speed), up to
  an hour, then runs anyway. A manual test always runs and is marked *line busy* if the line
  was in use; busy results read low, so they are left out of what counts as usual.
- A run takes about 15 seconds and moves roughly 80 MB on a 100 Mbit line (the first second
  of each transfer, while TCP ramps up, is left out of the rate).
- The first test runs a minute after the dashboard first starts. A restart never repeats a
  test that is not due; a failed one is retried after 30 minutes.
- **Alert** *Internet is slower than usual*: the last two quiet-line results were both under
  half of the median of the 14 before them (needs 5 earlier results). A line that is always
  slow never alerts.

What it measures is the dashboard host's path to the internet. If the router's port on the
switch negotiates 100 Mbps, that is the ceiling the test can read, whatever the ISP sells.

## Bandwidth by device

Each device plugged into the switch has a port, and the switch counts every byte through
it. The table shows, per port: down (to the device) and up (from it) now, a two-hour trend
of each, what it moved in the last 24 hours, and its share of the day. The name is the
port's description on the switch, the same as Network → Switch. The router's row reads
as the internet: down is what the house downloads, up what it uploads. Rows are ordered by what
they moved in 24 hours, the router first.

## The router's own counters (the Internet row)

Most routers with UPnP on answer a few read-only questions about their WAN side without a
login: is the link up, how fast, what is the public address, and how many bytes have crossed it.
The dashboard reads the byte counters every 15 seconds (`backend/wan.py`) and keeps ten-minute
buckets for 90 days, so the totals are exact sums, not guessed from rates.

**Why it matters:** a phone or TV on the router's own Wi-Fi is routed straight out of the router and
never touches a switch port. Measured here: 46 MB downloaded in two minutes, 0.3 MB of it to
anything on the switch. The switch alone makes the household look like it barely uses the
internet; the router's counters count all of it.

- **Internet** row: the router's counters (down, up, trend, totals), tagged *router WAN*.
- **Not on the switch** row, tagged *derived*: the router's download minus what it passed to the
  switch. That is the Wi-Fi devices and anything else on the router itself, not measured
  directly. Upload is not shown: LAN traffic to Wi-Fi devices crosses the same switch port, so
  the two can't be told apart and it isn't guessed. Its total is withheld until the router has
  been counted for the whole range.
- The speed test's "line is busy" check and the *Internet now* tile use these counters, so
  Wi-Fi-only use is seen too.
- Alerts: *the router's internet link is down* (the dashboard can still reach the router, so
  this tells a dead modem or cable from an unreachable website) and *internet link is nearly
  full* (90% for ten minutes).
- Counters are 32-bit and wrap every ~4 GB; a counter that drops by more than a wrap could
  explain is a reboot. If the router's UPnP is off, the Internet row falls back to the switch's
  router port, tagged *router link*.

Nothing is changed on the router: only UPnP "Get" calls to its own address, found by asking
the default gateway. `ROUTER_IP` and `WAN_UPNP_URL` override discovery; `WAN_FILE`,
`WAN_FULL_PERCENT` tune the rest.

**Still not possible:** per-device bandwidth for the Wi-Fi devices. The router's counters are
totals; telling the devices apart needs a router or firewall that reports per client (OPNsense
later), or the Wi-Fi moved onto an access point on the switch.

The range picker (2 h, 24 h, 7 d, 30 d) sets the trend's length and the totals' window (never under a day);
longer ranges are fetched when asked for and kept for 90 seconds. The trend and the totals are two Prometheus questions asked once a minute
(`backend/bandwidth.py`); the live rates come from the switch cache. If Prometheus can't be
asked, the last totals stay and the rates keep moving.
