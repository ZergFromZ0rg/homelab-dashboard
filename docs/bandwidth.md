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

**Limit:** only traffic that crosses the switch is counted. A phone or TV on the router's own Wi-Fi
reaches the internet through the router's own routing, never through the switch, so its traffic
is not in this table at all; only what passes between it and the wired devices is. The router's
row is tagged *router link* and is not counted in the share column. The scheduled speed test
decides whether the line is busy from the same port, so it can't see Wi-Fi-only use either.

To check on your network: start a large download on a phone over Wi-Fi and watch *In use now*.
If it doesn't move, that traffic bypasses the switch. Seeing those devices needs a source that
sees them (a router or firewall that reports per-client traffic), or Wi-Fi moved onto an
access point plugged into the switch, so that it crosses a port that can be mirrored.

The range picker (2 h, 24 h, 7 d, 30 d) sets the trend's length and the totals' window (never under a day);
longer ranges are fetched when asked for and kept for 90 seconds. The trend and the totals are two Prometheus questions asked once a minute
(`backend/bandwidth.py`); the live rates come from the switch cache. If Prometheus can't be
asked, the last totals stay and the rates keep moving.
