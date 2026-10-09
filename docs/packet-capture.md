# Packet capture, network watch and auto-capture

Network → **Packets** records traffic on a host (or inside one container) and
shows it live. Network → **Watch** holds two opt-in features built on the same
machinery: a watcher for ARP spoofing and rogue DHCP servers, and automatic
captures when a service check goes down.

Everything here is off, or idle, until you ask. Nothing is written to disk until
you save a capture.

## How a capture runs

```
browser ──▶ dashboard ──▶ agent ──▶ helper container ──▶ raw packet socket
 polls       /api/capture   /capture   host network (or a      kernel
 every 1 s   (token-gated)  keeps the  container's), NET_RAW
                            last 3000  only, read-only,
                            in memory  logging off
```

The sniffer is a throwaway container made from the agent's own image
(`capture_worker.py`). It reads an `AF_PACKET` socket, decodes frames by hand (no
tcpdump or libpcap), and prints one JSON line per packet and one per second for
totals. The agent reads those lines through an *attach* stream and keeps the
result in memory. Stopping, restarting or crashing the agent discards a capture.

## What is kept

| Mode (Payload) | Kept per packet |
|---|---|
| **Headers only** (default) | Ethernet, IP and TCP/UDP/ICMP headers. Nothing after them. |
| First 64 bytes | Headers plus 64 bytes of payload. |
| Full packets | Headers plus up to **1600 bytes** of payload — what *Follow stream* needs. Larger packets (a network card can merge several) are cut, and the stream view says how much was not kept. |

Read out of the payload and shown **whatever the mode**, because they are the
point of the list: a TLS server name, DNS names and answers, an HTTP request line
(**with its query string cut off** — that is where tokens live) and its `Host`,
and a DHCP host name. Cookies, headers other than `Host`, and bodies are only
ever in the hex of a *Full packets* capture.

Payload and promiscuous mode are chosen per capture and are **not remembered**
between visits, so a capture always starts from the careful setting.

## Limits

| | |
|---|---|
| One capture at a time per host | a second start is refused, not queued |
| Duration | 5 s – 10 min, then it stops itself |
| Packets held | the newest 3000 (the list, Follow stream and the `.pcap` read from these) |
| List rate | up to 120 packets/s (600 with *Full packets*); totals, conversations and protocol counts stay exact and the page says how many were left out of the list |
| Kernel drops | counted by the kernel and shown as a warning; they mean the counts are low |
| Loopback | each packet is counted once (the interface hands a sniffer two copies, as `tcpdump` also ignores) |
| Decoding | Python, so a saturated link will drop packets before `tcpdump` would; the drop warning is how you find out |

## Why the helper has logging switched off

A container's stdout normally goes to Docker's `json-file` log, in a root-owned
file under `/var/lib/docker/containers/<id>/`, **with no size limit, for as long
as the container exists**. The sniffer prints every packet, so with the default
driver a capture wrote each packet record — payload hex included — to the host's
disk (about 1 MB in four seconds). That broke the "nothing on disk" promise and
could fill a disk on a long capture.

So the helper is created with `log_config=LogConfig(type="none")` and its output
is read through `container.attach(stream=True)`, opened *before* the container
starts so no early line is lost. **Do not go back to `containers.run(detach=True)`
plus `.logs()`**: that needs a log driver. The same applies to the network watch's
helper. Check on a host with
`docker inspect --format '{{.HostConfig.LogConfig.Type}}' <helper>` while a
capture runs: it must say `none`.

## Filters

There are two, with the same language (tcpdump-style) and different jobs.

- **Capture filter** (next to *Start*): what the agent records at all. Fixed once
  started. Checked before anything starts; an error says where.
- **Display filter** (above the list): what is *shown* of what was recorded. Change
  it any time, on live and saved captures. If it doesn't parse as an expression it
  falls back to plain text search and shows why.

```
host 192.168.1.10 and port 443           tcp dst port 8096
net 192.168.1.0/24 and not arp           portrange 5000-5100
ether host aa:bb:cc:00:00:01             len > 1000
dns | tls | http | dhcp | ntp            sni *.example.com    name nas.lan
retransmit reset zerowindow dupack gap   problem   (any of those)
and / or / not (also && || !) and ( )     and binds tighter than or
```

`*.example.com` also matches `example.com`. The capture filter is evaluated in
Python on each decoded packet (`homelab-agent/capture_filter.py`), not compiled to
kernel BPF, so a mistake costs a message rather than a crash. The display filter
is a JavaScript port (`captureFilter.js`); they have separate test tables, so a
change to one needs the other changed by hand. Known differences: the display
filter's `net` takes IPv4 networks only.

## What is decoded, and the TCP problems it flags

Ethernet (with VLAN tags), IPv4, IPv6, ARP, TCP, UDP, ICMP/ICMPv6, DNS and mDNS,
TLS (server name only), plain HTTP, DHCP, NTP. Not decoded: QUIC/HTTP3 (encrypted
from the first packet), anything inside a TLS session, tunnels' inner packets.

TCP trouble is tracked per direction from sequence numbers, on every TCP packet
(before the capture filter, so a narrow filter doesn't blind it):

| Flag | Meaning |
|---|---|
| retransmit | bytes seen before were sent again (a 1-byte keep-alive probe is not one) |
| gap | the sequence jumped ahead: a packet was lost, reordered or missed |
| dup-ack | the third identical ACK in a row |
| zero-window | the receiver says its buffer is full |
| reset | the connection was reset |

A *reordered* packet is labelled retransmission (Wireshark would say
out-of-order). Treat the flags as pointers.

## Names

Addresses are shown by name where one is known. Highest priority first: a name you
gave the device (Network → Scans → rename); a node of this dashboard, and the
gateway; a container or the host itself (from the agent); the name a LAN scan
found; names seen in the capture (where a TLS hello or HTTP request was *sent to*,
and DNS answers). **No reverse-DNS lookups are ever made for a capture's
addresses**: they would tell your resolver who you were talking to. The *Names*
tickbox shows raw addresses; hover for the address and where the name came from.

## Capturing inside a container

*Capture where* → **inside `<container>`**, or the capture button on a running
container's row. The helper joins that container's network namespace
(`network_mode: container:<id>`), so it sees the traffic as the container does.
The interface is "all of its interfaces" (one namespace, so a packet is seen once)
or `eth0`.

## Saved captures

*Save* copies what the agent holds into the dashboard's data volume
(`/data/captures`, `CAPTURES_DIR`): a JSON file of the packets and a small metadata
file. The `.pcap` is built from the JSON when you download it, so there is one copy.
Up to 30 saved by hand and 200 MB in total; when full, saving is refused with a
message rather than deleting an old one. A saved capture holds what it was captured
with, so opening or downloading one is token-gated and audited like the live one.

## Network watch (Network → Watch)

Per host, **off by default**. A helper listens through a kernel BPF filter that
passes only **ARP** and **IPv4 UDP ports 67/68 (DHCP)**; nothing else reaches the
Python side (the helper used about 0% CPU during a 60 MB download). It keeps no
packets. The agent keeps what it learned in `/data/netwatch.json` so a restart
neither forgets the network nor lets a spoof right after it look like the baseline.

| It raises | Level | When |
|---|---|---|
| The gateway's address changed hands | **alert** | ARP spoofing — or you replaced the router, and the message says so |
| Address claimed by two devices | warning | the old owner was active; also a laptop going Ethernet ↔ Wi-Fi |
| Address went to a new device | info | the old owner had been quiet for over an hour: a lease handed on |
| Another DHCP server is answering | warning | a rogue or second server hands out conflicting leases |
| New device | info | a MAC never seen before (not announced during the first five minutes after the very first start) |

Warnings and alerts become ordinary alerts (Overview, alert history, ntfy). A
finding stays raised while it keeps being seen and resolves after **an hour** of
quiet. Information is listed, never alerted. Virtual router MACs (VRRP/HSRP) are
ignored, and a flood of new MAC addresses cannot push an alert out of the list.
Not covered: VLAN-tagged frames, and routers that answer ARP on behalf of other
addresses (proxy-ARP) can raise noisy "claimed by two devices" warnings.

## Auto-capture (Network → Watch)

When a service check **goes down or loses packets**, the dashboard asks the right
host's agent (the check's origin, else the dashboard's own host) for a short capture
of *that connection* (`host <ip> and port N`; DNS checks use `port 53`) and keeps it
under Saved captures, marked **auto**.

- It starts when the alert **fires**, after the check has failed enough times to
  count as down, so it records the failure continuing, not its first second.
- Always **headers only and never promiscuous**.
- At most 4 per host per hour, one per check per 10 minutes, one at a time per host;
  it steps aside for a capture you started, and an attempt that never recorded
  anything is not counted.
- It ignores the first couple of minutes after the dashboard starts: the alert
  monitor begins with nothing remembered, so checks that were *already* down "fire"
  again then.
- Only the newest few (default 10) are kept; older automatic captures are dropped,
  yours never are. *Try it on <host>* takes one now.

## Security and audit

Starting, stopping and saving a capture, downloading or opening a saved one,
switching the watch, and changing auto-capture all need the dashboard's token (or
a signed-in session) and are written to the audit log, as is each automatic
capture. The agent's `/capture` and `/netwatch` routes need `X-Agent-Token`, and
only a real JSON `true` switches things on (the string `"false"` does not). The
helpers run with `cap_drop: ALL` + `NET_RAW`, a read-only filesystem and logging
off.

## Tests

| What | How |
|---|---|
| Decoders, filters, controllers, detector, alert wiring | normal unit tests in each repo (`pytest`, `npm test`) |
| Decoders on hostile input | `tests/test_decoder_fuzz.py` — seeded, tens of thousands of truncated and corrupted frames; nothing may raise |
| **The real kernel** | `tests/test_live_capture.py` — real packets over loopback through the real sniffers: BPF acceptance (with an unfiltered control socket proving the noise was on the wire), kernel timestamps, drop counter, TCP flags, promiscuous mode. Linux + `CAP_NET_RAW` only, skipped elsewhere |

Run the live tests where the agent runs, in its own image (the container's own
loopback is used, so the host's network is untouched):

```bash
cd ~/homelab-agent
docker run --rm --cap-add NET_RAW -v "$PWD":/src -w /src homelab-agent \
  sh -c "pip install -q pytest && python -m pytest tests/test_live_capture.py -v"
```

They found a real bug the first time they ran: the loopback interface delivers each
packet twice, which doubled every count and made the second copy of every data
packet read as a retransmission.

## For maintainers

- `socket.AF_PACKET` does not exist on macOS: worker tests set it with
  `raising=False`; the live tests skip.
- Don't patch the global `time` module in a test: other threads and the test's own
  sleeps break, and a test can pass for the wrong reason. Give the module under
  test its own fake clock (`FakeClock` in `backend/tests/test_autocapture.py`).
- After trying the watch on a real host, delete `/data/netwatch.json` in the agent
  and restart it, or the user's first *Turn on* skips its learning window.
- On this Mac, don't run Python through `timeout`: it switches to an x86_64 binary
  where `pydantic_core` won't import.

## Troubleshooting

| You see | Meaning |
|---|---|
| "this agent can't capture packets yet — rebuild it" | the agent predates `/capture`; rebuild it |
| "…isn't a capturable interface on this host" | the interface list is the host's; a name saved from another host falls back to the default |
| "the helper isn't allowed a raw socket (needs NET_RAW)" | the Docker daemon refused the capability |
| "The kernel dropped N packets" | traffic arrived faster than Python could read it; narrow the capture filter or capture for less time |
| a capture with no packets | the filter matched nothing, or the interface carried nothing in that time |
| "a capture is already running" | one at a time per host: stop it first (an automatic capture may be the one) |
| Watch says "not running" | it retries with a growing pause; the message says why (no default route, helper couldn't start) |
