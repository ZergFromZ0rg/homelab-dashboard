# Homelab Dashboard

A live dashboard for a small homelab: host metrics from Prometheus,
container/GPU data from [homelab-agent](https://github.com/ZergFromZ0rg/homelab-agent)
instances, pushed to the browser over a WebSocket.

- `backend/` — FastAPI. Queries Prometheus for CPU/RAM/disk/network/temp,
  polls registered agents for containers and GPU, streams both over `/ws`.
- `frontend/` — React + Vite, served by nginx, which also proxies `/api/`
  and `/ws` to the backend.

## Previewing the UI without a backend

`npm run dev` in `frontend/`, then open `/?demo` — a fake three-host fleet
(GPU, unhealthy container, live-activity badges, alerts) renders with no
backend or agents running. Dev builds only; the fixture isn't part of the
production bundle.

## Adding a machine

Nothing here needs editing. Two things make a machine show up:

1. Point Prometheus at its `node_exporter` (job name = the hostname you
   want it known by).
2. Run `homelab-agent` on it with `DASHBOARD_URL` set to this dashboard's
   URL (through nginx, e.g. `http://dashboard-host:8081`) and `HOST_NAME`
   matching that same Prometheus job name.

The agent registers itself on `POST /api/nodes` on startup and every
`REGISTER_INTERVAL` seconds; the dashboard picks it up on its next
WebSocket tick (~2s). A machine with only Prometheus scraping (no agent)
still shows host stats, just no container list or GPU. A machine with only
an agent registered (no Prometheus target) shows containers/GPU with host
stats blank. See homelab-agent's README for its full env var list.

The backend polls each agent's `/containers` snapshot every tick with an
`AGENT_POLL_TIMEOUT` (default 8s). A single slow or dropped poll no longer
blanks the host — the last good snapshot (container list *and* GPU card)
keeps showing, flagged stale, for up to `AGENT_STALE_GRACE` seconds
(default 45) before the host falls back to "agent unreachable". A GPU card
showing a name like `NVIDIA GPU 10DE:2187` and no live metrics is the
agent's runtime-less fallback (the `10DE:2187` is the PCI id), and the
card now carries a line saying exactly that with the fix — it used to look
identical to an idle GPU. AMD and Intel cards report a vendor and a
temperature with no configuration at all; that's all `/sys/class/drm`
exposes, not a misconfiguration.

## Layout

Seven sections in a sticky top bar — **Overview**, **Servers**,
**Containers**, **Services**, **Deploy**, **Backups**, **Personal** — plus a gear button that opens
**Settings** as a right-hand drawer over whichever section you're on (Esc
closes it). The bar also carries the connection pill and the dashboard's
title/subtitle (both editable in Settings → Appearance). The layout reflows
down to phone width (the tab bar scrolls sideways there); below ~1040px
each container becomes a small stacked card.

**Overview** (default) is the one-glance page:

- a four-across summary row (health / hosts online / containers running /
  alert count);
- an **Attention** panel — one line ("No issues detected") when the fleet
  is healthy, otherwise a severity-coded list of problems each with a
  *View* jump and a plain next-step. Deterministic: it reuses the same
  checks the alert loop runs (`alerts.evaluate`) plus stale nodes, no LLM;
  host problems jump to the Servers tab;
- **Services** — a chip per service check with its latency (down ones
  first); click for the Services tab;
- **Servers** — one small tile per machine with its headline bars (CPU,
  RAM, fullest disk, GPU); red at 85%+. Click a tile for the full card;
- a right-hand rail: **Quick actions** (restart / stop for your pinned
  containers, jumps to Deploy / Containers) and **Recent activity**
  (container start/stop/restart, host up/down, agent unreachable and
  scheduler deploy/move/fail events, diffed from the fleet snapshot each
  reconcile tick and kept in `/data/activity.json`).

**Servers** is the full view of every machine: a facts row (servers online,
containers running, CPU threads, GPUs), then a card per host — CPU /
temperature / RAM gauges with sparklines, network (with a per-interface
breakdown — see below), every GPU, disk I/O and
storage, plus a footer with how many containers run there, whether its
agent is connected / stale / unreachable, and how its config backup is
doing ("backup 3h ago", "backup stale", "backup failing", "no backup"). Each
disk shows a fill forecast ("full in ~7 d") once it's within a month, amber
inside a week and red inside ~2 days. The facts row's **Backups** tile
counts hosts with a healthy backup out of those that have one set up. The machine the dashboard itself
runs on is marked "Dashboard host" and listed first.

**Containers** is one dense table row per container: name/image (with
live-activity and "scheduled" chips), status + health + a tiny heartbeat
strip, CPU, memory (with its limit, or "no limit"), network, uptime, and
Stop/Restart. The chevron on a row expands the rest — the full heartbeat,
cumulative traffic, disk I/O, image and root-filesystem size. Hosts are
grouped and open by default; each group has its own sort (name / CPU /
RAM / status), and its collapsed state and sort are remembered per browser
(`localStorage`). A filter box matches container name or image across
every host, and the status chips (All / Running / Needs attention /
Stopped) narrow it further; Expand all / Collapse all handle the groups.

**Services** answers "is it actually answering?" — a container being
`running` doesn't mean Jellyfin serves a page, the router responds, DNS
works or the internet is up. Add a **check** (a **Quick add** covers the two
everyone wants: *Internet* and *DNS*) and the backend probes it on a
schedule, keeping latency and history:

- **Website / API** (`http`) — GET a URL; up if it answers with a status
  below 400 after redirects, or with the exact status you set (handy for a
  login page that returns 401). A bare address gets a scheme: `http://` for
  an IP, `localhost`, a single-label name or `*.local/.lan/.home/.internal`,
  `https://` otherwise. "Accept a self-signed certificate" skips TLS
  verification for that check.
- **Website + text** (`keyword`) — like the above, and the page must also
  *contain* some text (or, with "Fail if this text is on the page", must
  *not* contain it). This catches what a plain status check can't: an app
  that serves a friendly error page with a `200`. Matching is
  case-insensitive over the first 512 KB of the page; a wrong status fails
  before the body is even read, and the latency shown is the time to
  download the page rather than just the headers.
- **Ping** (`ping`) — one ICMP echo to an IPv4 host or address, latency
  being the round trip. It uses an unprivileged ICMP socket (the shipped
  `compose.yml` sets `net.ipv4.ping_group_range` so this works without extra
  capabilities), falling back to a raw socket if the container has
  `CAP_NET_RAW`. If neither is allowed the check says so and suggests a
  Port check instead. Many hosts and networks drop ping; IPv6-only names
  aren't supported.
- **Port** (`tcp`) — open a connection to `host:port`.
- **DNS lookup** (`dns`) — resolve a hostname with the backend's resolver.

Each card shows the current latency (or *Down for 18m · HTTP 502*), a
sparkline of recent results, uptime over 24 h / 7 d / 30 d and the average
latency; **History** expands uptime bars and a latency chart for 3 h / 24 h /
7 d / 30 d. Edit, pause and delete are on the card, **Check now** probes
immediately. A check turns **down** only after `CHECK_FAILURES_BEFORE_DOWN`
(default 2) failed probes in a row, so one dropped packet doesn't flip it;
down checks appear in the Attention panel and, if a webhook is set, page you
(`check:<id>` alerts, resolved when it recovers).

Things to know: probes run **from the dashboard backend**, so they measure
reachability from where the dashboard lives — `localhost` means the
dashboard container itself, so use the LAN address or hostname of anything
on the same machine. Creating, editing, running or deleting a check needs
`API_TOKEN` when one is set (the backend sends requests to whatever address
it's given; enter the token in the form's token box). Checks
(`/data/checks.json`) and their history (`/data/check_history.json`: the
last 3 h of raw samples plus hourly buckets for 30 days, saved every minute
and on shutdown) live on the data volume, so a redeploy keeps your uptime
history. Limits: 100 checks, interval 10 s–1 h, timeout 1–30 s. Endpoints:
`GET/POST /api/checks`, `PUT/DELETE /api/checks/{id}`,
`POST /api/checks/{id}/run`, `GET /api/checks/{id}/history?range=3h|24h|7d|30d`
(the list also rides every `/ws` tick).

**Personal** is the non-fleet stuff, each card switchable in Settings:

- a **greeting** with the date, a clock, and a one-line fleet status;
- the editable **to-do list** — add / rename (click) / toggle / delete /
  drag-reorder, saved to `/data/todos.json` (`GET`/`PUT /api/todos`, in
  every `/ws` tick) so it's the same on every browser;
- **notes** — free-text notes, saved on the server (`/data/notes.json`) so
  what you write on your phone is on your desktop. The list shows each
  note's first line as its title; opening one gives an editor that
  **autosaves** ~1 s after you stop typing (and when you leave the tab), and
  a note you open and never write in is discarded. Every save says which
  version it was based on, so if you edit the same note on two devices the
  second save is refused and you're offered **Keep both**, **Use their
  version** or **Overwrite with mine** rather than one edit silently eating
  the other. Up to 100 notes of 20,000 characters; the list gets a search box
  past four notes. Notes are plain text on disk and readable by anyone who
  can reach the dashboard (like the to-do list) — don't keep secrets in them.
  API: `GET/POST /api/notes`, `PUT/DELETE /api/notes/{id}`;
- **weather** — current conditions and a 5-day forecast from
  [Open-Meteo](https://open-meteo.com/) (no API key). Pick your city right
  on the card (°C/°F toggle too); it's a per-browser preference;
- **word of the day** from English Wiktionary's feed;
- **quick links** — your bookmarks, added on the card. Bare LAN addresses
  (`192.168.1.1:8080`, `router.local`) default to `http://`, everything
  else to `https://`; only http(s) links are accepted. Stored per browser
  (`localStorage`) alongside the other display preferences.

Weather, city search and the word of the day are fetched **by the
backend** (`backend/personal.py`, `GET /api/personal/weather|places|word`),
not the browser, and cached in memory (weather 15 min, word 1 h, city
search 24 h). That means the `dashboard-api` container needs outbound
internet for those cards; if it has none they show "couldn't load" while
the rest of the dashboard is unaffected, and a failed refresh keeps serving
the last good value.

Any container can be **pinned** with the star on its row. Pinned
containers are lifted out of their host groups into a single **Pinned**
strip at the top (with a host chip on each row), so the ones you care
about are visible without expanding anything. Pins are stored on the
backend (`/data/pins.json`, `GET`/`PUT /api/pins`, and included in every
`/ws` tick), keyed by host + container name so they survive a redeploy
and show up the same on every browser. `localStorage` keeps a copy only
to avoid a flash of unpinned rows on the first paint after a reload.

Containers whose healthcheck is failing or that have restarted a lot
(`>= 5` by default, adjustable in Settings) float to the top of their host group ahead of the sort, with a
red edge marker. **Stop** and **Restart** ask for confirmation; a failed
control action shows its error inline on the row until dismissed.

The header status pill reads **LIVE** normally, **STALE `<n>`s** if the
socket is open but no update has landed in ~8s, and **RECONNECTING** with
an elapsed counter while the WebSocket is down — it retries on its own
with a backoff, so a dropped connection recovers without a refresh.

The machine the dashboard itself runs on is marked "Dashboard host" and
listed first among the host cards — auto-detected, no configuration
needed: Docker sets a container's `HOSTNAME` env var to its own short
container ID, and every agent already reports that same ID in its
container list (an agent lists every container on its host, dashboard-api
included), so the backend matches its own `HOSTNAME` against those lists
on every WebSocket tick. `MAIN_HOST` (Prometheus job / agent `HOST_NAME`)
is only needed as a manual override — e.g. the dashboard runs on a host
with no homelab-agent, so there's nothing for it to match against.

Each container's name links to its own web UI when the agent reports a
published host port for it (`ports` in homelab-agent's `/containers`
response) — `http://<host>:<port>`. Containers with nothing published
just render as plain text.

A handful of containers can report whether they're actually *in use*
right now, not just running: qBittorrent (active torrents) and Jellyfin
(active playback sessions) so far, via `backend/service_activity.py`.
Matched by image name; for a match, it hits that app's own API over the
fleet network — same host:port the name-link above would open — cached
per container for 15s so N browser tabs (each running their own `/ws`
loop) don't hammer the app's API every 2s. Shown as a small green badge
on the container row and in Quick Actions — e.g. "3 downloading, 5
seeding" or "1 user streaming (zerg)" — toggleable in **Settings**. Add a
new `(needle, probe_fn)` pair to `_PROBES` to extend it to another app.

Needs credentials, entered from **Settings → Live-activity credentials**
(saved server-side, `backend/service_activity_credentials.py`, `/data/
service_activity_credentials.json` — plaintext on disk, same trust model
as every other secret this project already keeps as an env var). A
`QBITTORRENT_USERNAME`/`QBITTORRENT_PASSWORD` or `JELLYFIN_API_KEY` env
var (see `.env.example`) still works and is used as a fallback when
nothing's set in Settings. A matched container with credentials from
neither place just gets no badge (logged once).

**Settings** (the gear in the top bar) holds per-browser display
preferences (`localStorage`, not synced across devices): the dashboard
title, the graph time window, whether the uptime column and live-activity
badges show, the restart-loop threshold, which Overview sections are visible,
and per-pin group labels + web-UI links for Quick Actions (e.g. label
qBittorrent + Jellyfin "Media" to group them under one header there).

### Network, per interface

The **download / upload** figures on a host card sum its *physical*
interfaces only — `VIRTUAL_IFACE_RE` in `backend/prometheus.py` drops the
loopback, Docker bridges, veths and, deliberately, overlay links like
`tailscale*` and `wg*`, so a busy tailnet doesn't read as WAN traffic.

That makes overlay traffic invisible in the headline number, so each card
also lists its interfaces individually underneath (`get_network_interfaces`,
rated over a minute like the disk I/O rows). This list hides only the
genuinely uninteresting churn — loopback and container/bridge plumbing — so
`tailscale0`, `wg0` and `tun0` do appear, tagged **not in total** to
explain why the rows don't add up to the figure above them. Interfaces
with no traffic at all in the window are left out.

This answers "which link is that traffic on". For "which peer", see below.

### Connections, per peer

Each host card has a collapsed **Connections** panel. Open it and the
dashboard asks that host's agent for its conntrack table
(`GET /api/connections/{host}` → the agent's `GET /connections`), and shows
one row per conversation: the two endpoints, the destination port, the
protocol, bytes each way and how many connections are being held open.

This is the one host-card panel that is **not** on the `/ws` payload. A
busy host's table is large and only interesting while someone is looking at
it, so the fetch happens when the panel opens and the answer is cached for
30 seconds (`backend/connections.py`); the panel's own Refresh button
skips that cache.

Where the agent can tell which container owns a flow, the row reads as
`jellyfin ← 192.168.1.40:8096` — the arrow is the direction, and the two
byte columns are what **this host** received and sent. Both ends are named
when both are containers (`booklore → booklore-db:5432`).

That distinction is doing real work. conntrack counts bytes per direction
of the *connection*, not of the host, so for an inbound flow the counters
are swapped: reading them raw would report a 4 GB stream *out* of Jellyfin
as 4 GB coming in.

Traffic that isn't a container's is named by the **process** holding the
socket instead — `gitea → 140.82.121.4:443` — in plain text rather than the
accent colour, so the two kinds of owner stay apart at a glance. A row
with neither is dimmed: the socket had already closed (conntrack keeps an
entry a while after), or the agent couldn't read the host's socket tables,
in which case the panel says so.

Rows without a container keep their raw conntrack endpoints either way
(`src` opened the connection, and the byte columns are that connection's
two directions). They aren't relabelled, because deciding which end is
local would mean guessing from address ranges, and both ends of an inbound
LAN connection are private.

The panel needs the agent set up for it: its host's conntrack table has to
be readable (free if that agent already mounts the host filesystem for
config backups) and `net.netfilter.nf_conntrack_acct=1` has to be on for
byte counts. When either is missing the agent says exactly which, and the
panel prints that verbatim rather than a generic failure. An agent too old
to have the route reads as "rebuild it"; one that rejects the dashboard's
token says to match `AGENT_TOKEN`. See **Network Connections** in the
homelab-agent README.

Per-container throughput totals are already on each container row.

## Container history

Expanding a container's row shows its CPU and memory over **6h / 24h /
7d**, hovered for an exact reading at any point.

Two charts, not one. CPU percent and memory bytes on shared axes would
need two y-scales, and the point where the two lines cross would then mean
nothing — an artefact of how the axes were picked, which readers
nonetheless read as a relationship.

`backend/container_history.py` folds the samples the reconcile loop
already collects into **five-minute buckets kept for a week**
(`CONTAINER_HISTORY_DAYS`). It's keyed by container *name*, not id: an id
changes on every recreate, so an id-keyed series would reset itself on
every deploy — exactly when comparing before and after matters most. A
week's buckets are downsampled server-side to about 300 points, since
that's more than the chart has pixels for.

Like the connections panel, this is **not** on the `/ws` payload —
`GET /api/containers/{host}/{name}/history?range=` is fetched when a row
is opened. Sending every container's week to every client every two
seconds would be absurd.

## History and sparklines

CPU, RAM, CPU temperature, and network cards carry a small trend line,
sourced from Prometheus range queries (`get_machine_history` in
`backend/prometheus.py`) covering the last 2 hours at 1-minute
resolution. That query is re-run at most once every 30s and cached — the
`/ws` loop calls it every 2s like everything else, but reuses the cached
series in between instead of re-hitting Prometheus every tick. **Settings
→ Graphs → Time window** (10m/15m/30m/1h/2h) slices this client-side
(`frontend/src/components/historyWindow.js`) rather than re-querying, so
picking a narrower window is instant.

GPU temperature and each container's up/down status don't come from
Prometheus at all (GPU is agent-reported, container status is a live
Docker snapshot), so `backend/live_history.py` keeps its own 2-hour
rolling buffer, sampled once per reconcile tick (~5s) — from the
always-on loop, *not* the `/ws` loop, so the heartbeat has no gaps when
no browser is connected — and persisted to `/data/live_history.json`
(same volume as the node registry) at most once every 30s, so redeploying
the dashboard doesn't wipe history for containers that never actually
restarted. Keyed by `(host, container_id)`
for containers, so a container that *is* recreated naturally starts a
fresh history under its new id rather than inheriting the old one's.
This is meant to answer "is this flapping right now", not to be a
long-term record.

Each container gets a heartbeat bar plus a recent uptime % (fraction of
samples where Docker reported it `running` and, if it has a healthcheck,
not `unhealthy`) — a passive read of container status already being
polled, not an active HTTP check the way Uptime Kuma monitors a URL. The
backend always sends 120 native one-minute buckets (the full 2h it
keeps); the frontend slices to **Settings → Containers → Heartbeat
window** (30m/1h/2h) and merges into 30 visual bars
(`frontend/src/components/Heartbeat.jsx`) — a shorter window means each
bar covers less time, so a brief blip is easier to spot.

## Deploying containers (scheduler)

The **Deploy** tab submits a container spec (image, env, ports, volumes,
restart policy, CPU/RAM limits, constraints) and the backend picks a node
for it:

1. `backend/scheduler.py` scores every registered node against the spec —
   hard filters (offline, no GPU when required, not enough free RAM, disk
   too full, a requested host port already bound on that node, constraint
   violations) then a worst-fit headroom score with penalties for wasting
   a GPU box, a hot CPU sensor, or a stale agent. Pure arithmetic over the
   same stats the dashboard already streams.
2. The backend `POST`s the chosen node's agent at `POST {agent}/containers`
   to pull and run the image, and records the deployment in
   `/data/deployments.json`. A background loop reconciles each record
   against the live container snapshot every few seconds (independent of
   whether a dashboard client is connected): a vanished, stopped, or
   `unhealthy` container flips the record to `failed`; an unreachable host
   to `node_offline`; a container that comes back to `running` logs
   `recovered`.

**Compose stacks** — the Deploy tab has a "Compose stack" mode: paste a
`docker-compose.yml` and a project name. `backend/compose.py` parses it
(per-service image / published ports / resource limits) and
`backend/stacks.py` synthesises one placement spec from the *sum* of the
services' limits and the *union* of their ports — a compose project's
services share a network, so they co-locate. The backend `POST`s the whole
YAML to `POST {agent}/stacks`, which writes it out and runs `docker compose
up -d`. Named volumes only (bind mounts must be under the agent's
`ALLOWED_HOST_PATHS`); `build:` is rejected — push a pre-built image.
Reconcile matches a stack's containers by their `com.docker.compose.project`
label; "redeploy elsewhere" tears the project down and brings it up on a
new node.

**This needs homelab-agent with `POST /containers` / `DELETE
/containers/{id}`** (the commits that add `deploy.py`; older agents only do
start/stop/restart and the Deploy tab will get "agent rejected"). Because
these routes pull and run arbitrary images as root:

- Set `API_TOKEN` before exposing the dashboard beyond a trusted network.
- Set `AGENT_TOKEN` on both sides (dashboard env + each agent's
  `AGENT_TOKEN`) so agents reject calls that don't come from the dashboard.
- Keep each agent's `ALLOWED_REGISTRIES` / `ALLOWED_HOST_PATHS` policy
  tight — that policy, enforced agent-side, is the real containment
  boundary.

The Deploy tab also shows **rebalancing suggestions** (`GET /api/rebalance`,
`backend/rebalance.py`): when a node running scheduler-managed containers
goes over `REBALANCE_CPU_PERCENT` / `REBALANCE_RAM_PERCENT`, it re-scores
each *stateless* container there against the other nodes and proposes a
move if one scores at least `REBALANCE_MIN_GAIN` points better. Suggestions
only — "Move" runs the same redeploy path.

Every placement decision — deploy, move, reschedule, fail, recover — is
also written to stdout on the `scheduler` logger (`LOG_LEVEL` controls
verbosity). `docker compose logs dashboard-api | grep ' scheduler '` is a
fleet-wide audit trail; the agent has its own `audit` logger for every
container/stack mutation it's asked to make.

Set **`AUTO_REBALANCE=1`** and the backend acts on them itself
(`backend/autorebalance.py`): a background loop every
`AUTO_REBALANCE_INTERVAL` seconds executes moves clearing the higher
`AUTO_REBALANCE_MIN_GAIN` bar, at most `AUTO_REBALANCE_MAX_PER_CYCLE` per
cycle, with an `AUTO_REBALANCE_COOLDOWN` per deployment so a flapping node
can't cause a move storm. The same loop **reschedules** stranded stateless
single containers off a node that has gone `node_offline` onto a healthy
one. Every deployment carries an **event log** (`created` / `deployed` /
`failed` / `recovered` / `moved` / `node_offline`, `moved` flagged
`automatic` for a rebalancer/reschedule move) shown on its card.

Not in scope: compose stacks, automatic rescheduling when a node dies
(there's a manual "redeploy elsewhere" button), cross-node networking, and
stateful volume migration (a named volume stays on its node).

## Agent versions

Each host card carries a chip saying what its agent is running:

| Chip | Means |
| --- | --- |
| `agent db2e663` | up to date |
| **rebuild to apply** | the checkout on that host has moved past the running image — someone pulled and didn't rebuild |
| **update available** | the remote has commits that host doesn't; a rebuild pulls them |
| `agent version unknown` | an agent from before version reporting; rebuild it once |

The agent works this out from three facts (`GET /version`): its checkout's
HEAD, when its image was built, and one `git ls-remote`. It compares the
image's **build time** against the commit date rather than a commit baked
in at build time — a baked commit goes wrong as soon as a container is
restarted without being rebuilt, which happens a lot.

`backend/versions.py` polls it and caches for a minute, the same way
backups are polled; a briefly unreachable agent keeps its last known
version rather than blanking, since the card already says it's
unreachable.

## The Prometheus join

Host CPU, RAM, disk and temperature come from Prometheus; containers come
from the agent. The two are joined on **one string**: an agent's
`HOST_NAME` must equal its Prometheus `job_name`.

Nothing enforces that, and until now a mismatch failed in the worst
possible way — silently. A reachable agent is marked `online`, so the host
card renders with every gauge blank and nothing anywhere says why.

`backend/prometheus_link.py` compares the registered agents against the
jobs Prometheus actually has and raises an Attention issue for any that
don't line up. Where the name is close it says which job you probably
meant:

> **bigboy has no Prometheus job** — bigboy's agent is reporting, but
> Prometheus has no job called bigboy, it has Bigboy. Host metrics are
> blank until the two names match.

Where it isn't, it gives you the stanza to paste:

```yaml
  - job_name: newbox
    static_configs:
      - targets: ['100.72.159.83:9100']
```

The target address is taken from the agent's own registered URL, on
node_exporter's port — the agent is already reachable there, so the
exporter almost certainly is too.

Nothing is reported when Prometheus itself is unreachable. Every host
looks unmatched then, and burying the one real problem under a list of
false ones is worse than saying nothing.

## Adding a node

The Servers tab ends with an **Add a node** panel: a `curl | sh` command
with this dashboard's address already in it. Run it on the new machine and
the node appears here within a minute — Docker is the only prerequisite.

The address comes from `window.location.origin`, the URL *you* reached the
dashboard at. The backend can't supply it: it sees a bind address, not
however you got here. The browser's copy is the one address known to work
from somewhere other than the dashboard's own host, which is exactly what
the new node needs.

Two things the panel says out loud, because both are silent failures
otherwise: the host's name must match its Prometheus `job_name` or it
shows containers with no host metrics, and a dashboard with `API_TOKEN`
set needs `--token` on that command.

## Updating the fleet

The Servers tab's **Agents** tile counts how many are current and offers
one button when any aren't. It only appears when something is actually
out of date — a control that does nothing most of the time teaches you to
ignore it.

`POST /api/fleet/rebuild` asks each agent to rebuild **itself**
(`POST /rebuild/self` on the agent, so the dashboard never has to work out
which container is the agent on a given host). It returns as soon as every
job exists rather than waiting for builds that take minutes, and one host
refusing doesn't stop the rest — the result is reported host by host.

**The dashboard's own host goes last.** Rebuilding its agent takes that
agent down for a minute, and on a single-box setup it's also the machine
serving the page you started from; doing it first means watching the rest
of the fleet through a connection that just dropped.

## Rebuilding from the dashboard

A **Rebuild** button on a container row pulls its Compose project's git
checkout on that host and brings it back up with `--build`. It's how you
update the agents themselves without SSHing to three machines.

The button only appears where the agent reported a target: a container
Compose started, whose project directory is a git checkout, on a host that
has opted in. Its absence is the answer — there is nothing to configure on
the dashboard side.

It also appears on the agent's own row, which otherwise shows only
`Protected`. That protection is about not stopping or deleting the agent;
replacing it with a newer build is exactly what you want from here. The
agent can't run that one itself — `compose up` would kill the process
doing the running — so it hands the work to a throwaway container and the
job comes back `handed_off`. The result shows up as the agent coming back
online.

**This is off by default, and deliberately so.** `git pull` runs whatever
hooks the repo carries and `--build` runs whatever the Dockerfile says, so
it is arbitrary code execution on that host — which is the point, and why
each agent needs `REBUILD_ENABLED=1` before it will do it. `POST
/api/rebuild/{host}` also requires the dashboard's own `API_TOKEN`, making
it the only dashboard route with that property for that reason. See
**Rebuilding** in the homelab-agent README.

An `ssh` remote pulls fine: the agent has no keys and needs none, so it
derives the `https` URL for the same public repo and fetches that. Your
remotes and your push auth are untouched.

**build only** appears only for a remote that is no kind of fetchable URL
— a local path, say. Those rebuild from whatever is checked out, and the
confirm says so.

A build takes minutes, so the button starts a job and polls
`GET /api/rebuild/{host}/{job_id}` until it settles — `done`, `failed`
with the failing step's output on hover, or `handed_off`. One rebuild at a
time per host.

## Volume backups

The config backup each agent already runs covers how a stack is *defined* —
its compose files, pushed to a git repo. It does not cover what the
containers have written. A database, a media library, a vector store: those
live in named Docker volumes, and nothing was copying them.

The **Backups** tab schedules that. One job is:

> this source, on this host, to this directory on that host, every so
> often, keeping so many.

A **source** is either a named Docker volume or a host directory. The
second matters more than it sounds: plenty of stacks keep their data in a
bind mount — `./data/qdrant:/qdrant/storage` — and those are invisible to
anything that only understands volumes. Directory sources are opt-in per
host, because sending a directory to another machine deserves a decision
naming which directories:

```
BACKUP_SOURCE_DIRS=/home/you/ai-librarian
```

A job may then name that directory or anything under it. Unset means named
volumes only, which is the default. The agent reads the directory through
the `/host` mount it already has, so nothing else changes.

By default a backup goes to the machine running the dashboard, because a
copy that lives on the box it came from dies with it. The form says so out
loud if you point a job back at its own host.

### How a backup is taken

A throwaway container is started on the source host with the volume bound
read-only, and it tars the volume through gzip. Nothing is installed to
make that work — the helper runs the agent's own image and uses only the
standard library, so a backup can't break because a future Dockerfile
change dropped a tool.

Where the archive goes depends on the destination:

- **Same host** — the helper has the destination bound at its real host
  path and writes the archive itself.
- **Another node** — the helper streams the archive to that node's agent,
  chunked, and that agent writes it. The archive never exists in full in
  anyone's memory or on any intermediate disk, so the size of a volume is
  not the size of anything you need spare.

Both ends hash the bytes. If what landed isn't what was sent, the run
fails and says so, rather than leaving you to find out at a restore.

### Letting a host store backups

A host is a valid destination only once you have said so, because the
agent writes received archives itself and an unconstrained destination
would be an arbitrary-file-write primitive on the host. One line in the
agent's `.env`:

```
BACKUP_HOST_DIR=/home/you/backups
```

Compose binds that directory at `/backups` and the agent stores archives
there. Nothing else to edit — the mount is in the shipped `compose.yml`,
defaulting to a throwaway named volume, so a host that stores no backups
has none of its filesystem bound in.

The mount is still the allowlist: the agent can only ever write under that
one path, and the read-only `/:/host:ro` mount the other features use
deliberately does not qualify. A job may name any directory under it; it
is created if it isn't there. Unset means the host stores nothing — it can
still be a *source* for a backup kept elsewhere. `BACKUP_DIRS` names roots
directly if you want more than one, or a mount you set up yourself.

If the destination agent registers under a name only the dashboard's own
Docker network resolves (a container name), set `BACKUP_PUBLIC_URL` to an
address other hosts can reach, since it is the *source host's helper* that
connects.

### Retention

`keep` is a count of that job's own archives. Several jobs can share a
directory, and pruning only ever deletes files whose name matches that
job's source — anything you put there by hand is left alone. A path's
slashes become dashes, so `/home/zerg/ai-librarian/data/qdrant` writes
`home-zerg-ai-librarian-data-qdrant-<stamp>.tar.gz`.
Pruning runs after a successful upload, never before, so the window where
the new archive doesn't exist yet is never a window where the old one is
already gone.

### Consistency

A volume tarred while a database is writing to it can restore to a torn
file. **Stop its containers while copying** stops everything using that
volume for the duration and starts it again afterwards, and the form names
the containers it would stop. The agent's own container is never stopped;
if one is skipped, the job says which.

### Restoring

The dashboard does not restore for you. Restoring is a deliberate,
destructive act with a stopped stack and a decision about what to
overwrite, and a button for it would be a button for losing data.

What the Archives panel does is **spell out the steps with this job's real
hosts, paths and containers in them**, because a restore happens rarely,
under pressure, and usually by someone reading it for the first time. For a
directory backed up from one host to another that is:

```bash
# on thinkpad — the archive lives where it was sent, not where it came from
scp /backups/bigboy/<archive> bigboy:/tmp/

# on bigboy
docker stop ai-librarian-qdrant-1
sudo rm -rf /home/zerg/ai-librarian/data/qdrant/* \
  && sudo tar xzf /tmp/<archive> -C /home/zerg/ai-librarian/data/qdrant
docker start ai-librarian-qdrant-1
```

The copy between hosts is the step a one-line hint skips and the one that
makes the rest not work. For a *volume* source the middle step goes through
a container instead, since a volume has no path to extract into:

```bash
docker run --rm -v <volume>:/dest -v /tmp:/src:ro \
  alpine sh -c 'rm -rf /dest/* && tar xzf /src/<archive> -C /dest'
```

**Verify** on any archive reads it back on the host holding it —
decompresses the whole thing and walks every member — and reports intact or
the reason it isn't. It is the closest thing to a restore that writes
nothing. An archive is also an ordinary gzipped tar, so `tar tzf` reads it
anywhere with or without this dashboard, which is the point of not choosing
a format with its own reader.

### When a backup stops working

A failing job raises an alert like any other problem: **bad** when a run
fails, **warn** when the last success is older than one and a half
intervals. It appears in the Attention panel, in the alert history, and on
your webhook if one is set. A paused job raises nothing — pausing is a
decision, not a fault.

## Settings from the dashboard

Every switch on an agent used to live in a `.env` file on its host, so
turning a feature on meant an ssh session, an editor and a
`docker compose up -d`. Worse, getting it wrong failed *silently*: the
agent came up healthy and quietly didn't do the thing.

Each host card now has a **Settings** panel. It reads that agent's own list
of settings — what they mean, what they're set to, and where the value came
from — and writes the ones that can be written.

### What it does not do

It does not edit `.env`, touch compose, or restart anything. An agent that
could rewrite its own environment and restart itself would be remote code
execution on the host by another name: `AGENT_RUNTIME`, `REBUILD_ENABLED`
and the deploy allowlists all become arbitrary code the moment they can be
set remotely.

Instead a setting goes to a JSON file on the agent's own volume and is read
back at call time, layered over the environment. The blast radius is that
one process, and the worst a bad request can do is misconfigure the agent.
Changes apply to the next request — nothing restarts.

### Host-scoped settings

Anything the container fixed before the agent existed — a bind mount, the
runtime, the bind address — cannot work that way, because compose read it
first. Those are shown greyed, with where the current value came from and
what to do about it, rather than pretended at. The set is deliberately
small:

| Setting | Why it's fixed |
|---|---|
| `BACKUP_HOST_DIR` | it is a bind mount |
| `AGENT_RUNTIME` | the container's runtime |
| `HOST_NAME` | changing it orphans every metric under the old name |
| `AGENT_TOKEN`, `LOG_LEVEL` | read once at startup |

### Turning it on

Writing is opt-in per host, the same shape as `REBUILD_ENABLED`:

```
CONFIG_WRITABLE=1
```

Without it the panel is read-only and says so — reading always works, so
the page can show what is configured and explain the rest instead of being
blank. **Note what this grants**: anyone who can reach the dashboard can
then change these settings, including `REBUILD_ENABLED`. Set `API_TOKEN` on
the dashboard before enabling it on a host you care about.

## Authentication

There is none by default, and that is a choice the dashboard now states
out loud rather than leaving you to discover.

`API_TOKEN` is unset out of the box, so every route is open to anyone who
can reach the dashboard. Behind Tailscale on a network you trust that is a
reasonable posture — it is the one this fleet runs. Exposed to anything
wider it is not, because "reach the dashboard" means stop containers,
rebuild hosts, change agent settings and store service credentials.

**The boundary is already drawn in the code.** Every route that can affect
a host calls `auth.check_token`, which is a no-op while `API_TOKEN` is
unset. Turning authentication on is therefore one environment variable, not
an audit:

```
API_TOKEN=<something long>        # on the dashboard
REGISTER_TOKEN=<the same value>   # on each agent
```

Deliberately **not** gated: pins, notes and the to-do list. They are this
browser's view state and personal scratch space, and nothing they change
reaches a host.

The Attention panel carries a standing footnote while the dashboard is
unauthenticated. It is a footnote rather than an issue on purpose: an issue
that can never be cleared would mean the panel is never clean, and "no
issues detected" is a signal worth keeping honest. This is a posture, not
an incident.

## Alerting

`backend/alerts.py` runs a loop every `ALERT_INTERVAL` seconds (default
60) over the same fleet snapshot the scheduler uses and records a state
change when something crosses a line — and again when it clears. Set
`ALERT_WEBHOOK_URL` to also have each change `POST`ed to you; without it
the loop still runs and still keeps the history below.

- a host Prometheus had `online` goes offline
- a host is up but its agent stops responding
- a host's RAM (`ALERT_RAM_PERCENT`, default 90) or CPU
  (`ALERT_CPU_PERCENT`, default 95) sits over threshold for
  `ALERT_BREACH_CYCLES` consecutive checks (default 2 — a single spike
  won't page you; host-offline and deployment failures fire on the first
  check)
- a filesystem passes `ALERT_DISK_PERCENT` (default 90, critical at
  `ALERT_DISK_CRITICAL_PERCENT`, default 97), or is on course to fill within
  `ALERT_DISK_FORECAST_DAYS` (default 7) at its current rate — see below;
- a CPU or GPU temperature passes `ALERT_TEMP_CELSIUS` (default 85);
- a container's healthcheck is failing, or it's crash-looping (Docker says
  it's restarting, or it has restarted `ALERT_RESTART_COUNT` times (default
  5) and started within `ALERT_RESTART_WINDOW_MINUTES` (default 30) — the
  window keeps a container that restarted five times last spring from
  alerting forever);
- a host's configuration backup is failing or stale — see below;
- a service check is down (see **Services** above);
- a scheduler-managed deployment goes `failed` or `node_offline`

These same rules drive the Overview's **Attention** panel (worst first,
each with a next step), with or without a webhook — the webhook just also
pushes them to you.

**Disk-full forecast.** Each filesystem carries `days_until_full`, from
Prometheus: `free_space / -deriv(free_space[DISK_FORECAST_WINDOW])`
(default window `24h`), only for disks that are actually filling and only
when it's under a year out. It's re-queried at most every 5 minutes, and
shows on the Servers tab as "full in ~9 d" beside the disk. The trend is a
regression over the window, so a big download that's later deleted can
briefly look alarming; a longer window smooths that, a shorter one reacts
faster to a runaway log.

**Backup status.** Each agent's `GET /backup` (its scheduled push of your
compose files to a git repo — see homelab-agent's Configuration Backup) is
polled by the backend (cached a minute) and reduced to one state: `ok`,
`stale` (last success older than `ALERT_BACKUP_MAX_AGE_HOURS`, default: 1.5x
the agent's interval and at least interval + 2 h), `failing` (the last
attempt errored), `pending`, `not_configured`, `disabled`, or `unsupported`
(an agent old enough to lack the route). Ages are measured against the
agent's own clock, so a skewed host clock can't fake a stale backup. Only
`failing` and `stale` alert; a host with no backup configured just shows
"no backup" on its Servers card.

Only state *changes* are sent, so a condition that stays true doesn't
repeat. The body is deliberately generic —
`{status: "firing"|"resolved", key, title, message, host, severity,
timestamp}` — so it works with ntfy, Gotify, Discord, Slack-compatible
webhooks, healthchecks.io, or your own receiver. Transitions are also
logged on the `scheduler` logger.

**Alert history.** Every transition is also kept on the `/data` volume
(`ALERT_HISTORY_FILE`, default `/data/alerts.json`, last 200), so the
dashboard can answer "what went off last night?" without digging through
whatever received the webhook. It's stored as *episodes* — one entry per
alert key, opened when it fires and closed when it resolves — which is
what the Overview's **Alert history** card shows: still-firing ones first
with how long they've been going, then resolved ones with how long they
lasted. `GET /api/alerts` returns the same list, and it rides the `/ws`
payload. An episode left open by a dashboard restart is closed on the
next cycle that doesn't re-fire it.

## Setup

```bash
./setup.sh
```

Writes `.env` and starts the dashboard. It asks four things — the
Prometheus URL, whether to generate an `API_TOKEN` and an `AGENT_TOKEN`,
and an optional alert webhook — and leaves everything else at the defaults
in `.env.example`. Re-running is safe; every answer defaults to what's
already there and existing tokens are never regenerated.

It checks Prometheus is reachable and, when it isn't, says why that might
be fine (a container name only resolves inside the Docker network, not
from your shell) rather than failing. That dependency is the one that
breaks silently: without it you get containers and blank gauges with
nothing explaining the difference.

At the end it prints the command to add your first node, with the token
already in it. The agent has the matching `./setup.sh` and `install.sh`.

## Run

Standing the whole system up (Prometheus, the dashboard, an agent per
host, and turning on deploys/auto-rebalance safely) is in
**[docs/deployment.md](docs/deployment.md)**. The short version:

```bash
cp .env.example .env   # adjust PROMETHEUS_URL / ALLOWED_ORIGINS / API_TOKEN / AGENT_TOKEN
docker compose up -d --build
```

Backend tests: `pip install -r backend/requirements-dev.txt && python -m pytest backend/tests`

The compose file joins an external Docker network named `prometheus_default`
(the network your Prometheus container is on) so the backend can reach
Prometheus by name — see the deployment guide if yours is called something
else or runs outside Docker.

## API

All mutating routes are gated by the `X-Register-Token` header when
`API_TOKEN` (alias: `REGISTER_TOKEN`) is set.

- `GET /api/nodes` — registered agents (name, url, last_seen, stale)
- `POST /api/nodes` — agent self-registration, `{"name", "url"}`
- `DELETE /api/nodes/{name}` — deregister a node
- `POST /api/containers/{host}/{container_id}/{start|stop|restart}` —
  proxies a control action to that host's agent
- `GET /api/pins` / `PUT /api/pins` — the pinned-container list
  (`{"pins": ["host/name", …]}`); also in every `/ws` tick
- `POST /api/deployments` — body is a `DeploymentSpec`. `?dry_run=1`
  returns the scored ranking without deploying; otherwise it deploys to
  the top node (or `?node=<name>` to override to another eligible node)
  and returns the `DeploymentRecord`.
- `GET /api/deployments` / `GET /api/deployments/{id}` — managed deployments
- `GET /api/fleet` — per-node headroom, scheduler-committed vs online
  capacity, and a deployment status tally
- `GET /api/rebalance` — `{suggestions, checked_at, auto}`; stateless
  managed containers on an overloaded node that would score better
  elsewhere (`auto` reflects `AUTO_REBALANCE`)
- `POST /api/deployments/{id}/redeploy` — re-score and move it
  (`?exclude_current=1` by default keeps it off its current node)
- `DELETE /api/deployments/{id}` — remove the record and, unless
  `?keep_container=1`, tell the agent to delete the container
- `GET /ws` — WebSocket, pushes
  `{type, machines, containers, main_host, history, deployments, pins,
  server_time}` every 2s
