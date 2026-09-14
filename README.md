# Homelab Dashboard

A live dashboard for a small homelab: host metrics from Prometheus,
container/GPU data from [homelab-agent](https://github.com/ZergFromZ0rg/homelab-agent)
instances, pushed to the browser over a WebSocket.

- `backend/` — FastAPI. Queries Prometheus for CPU/RAM/disk/network/temp,
  polls registered agents for containers and GPU, streams both over `/ws`.
- `frontend/` — React + Vite, served by nginx, which also proxies `/api/`
  and `/ws` to the backend.

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
(default 45) before the host falls back to "agent unreachable". If the
GPU card shows a name like `NVIDIA GPU 10DE:2187` and no live metrics,
that's the agent's NVML-less fallback (the `10DE:2187` is the PCI id) —
give homelab-agent GPU access on that host to get the real name, VRAM,
utilization, temp and power.

## Layout

Five tabs. **Overview** (default) is the at-a-glance control surface:

- a four-across summary row (health / hosts online / containers running /
  alert count);
- an **Attention** panel — one line ("No issues detected") when the fleet
  is healthy, otherwise a severity-coded list of problems each with a
  *View* jump and a plain next-step. Deterministic: it reuses the same
  checks the alert loop runs (`alerts.evaluate`) plus stale nodes, no LLM;
- **Hosts** — a compact CPU / RAM / disk / GPU bar row per host (the full
  gauges stay on System Stats);
- **Quick actions** — restart / stop for your pinned containers, jumps to
  Deploy / Containers;
- **Recent activity** — container start/stop/restart, host up/down, agent
  unreachable and scheduler deploy/move/fail events, diffed from the fleet
  snapshot each reconcile tick and kept in `/data/activity.json`;
- an editable **to-do list** — add / rename (click) / toggle / delete /
  drag-reorder, saved to `/data/todos.json` (`GET`/`PUT /api/todos`, in
  every `/ws` tick) so it's the same on every browser.

**System Stats** is the old host view — the Main System panel plus
the Nodes grid. **Containers** shows every host's containers in one place,
grouped and collapsible per host, each group with its own independent
sort control (name / CPU / RAM / status). Each
group's collapsed state and sort choice are remembered per browser
(`localStorage`). A filter box at the top matches container name or image
across every host and auto-expands the groups that still have matches.

Any container can be **pinned** with the star on its row. Pinned
containers are lifted out of their host groups into a single **Pinned**
strip at the top (with a host chip on each row), so the ones you care
about are visible without expanding anything. Pins are stored on the
backend (`/data/pins.json`, `GET`/`PUT /api/pins`, and included in every
`/ws` tick), keyed by host + container name so they survive a redeploy
and show up the same on every browser. `localStorage` keeps a copy only
to avoid a flash of unpinned rows on the first paint after a reload.

Containers whose healthcheck is failing or that have restarted a lot
(`>= 5`) float to the top of their host group ahead of the sort, with a
red edge marker. **Stop** and **Restart** ask for confirmation; a failed
control action shows its error inline on the row until dismissed.

The header status pill reads **LIVE** normally, **STALE `<n>`s** if the
socket is open but no update has landed in ~8s, and **RECONNECTING** with
an elapsed counter while the WebSocket is down — it retries on its own
with a backoff, so a dropped connection recovers without a refresh.

The machine the dashboard itself runs on gets its own full-width "Main
System" panel at the top of Overview instead of being listed as just
another node in the "Nodes" grid below — auto-detected, no configuration
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
(active playback sessions) so far, via `backend/service_activity.py`. It
matches by image name and, for a match, hits that app's own API over the
fleet network — same host:port the name-link above would open — cached
per container for 15s so N browser tabs (each running their own `/ws`
loop) don't hammer the app's API every 2s. Needs credentials set on the
backend (`QBITTORRENT_USERNAME`/`QBITTORRENT_PASSWORD`,
`JELLYFIN_API_KEY` — see `.env.example`); a matching container with none
set just gets no badge (logged once). Shown as a small green badge on the
container row and in Quick Actions — e.g. "3 downloading, 5 seeding" or
"1 user streaming (zerg)" — toggleable in **Settings**. Add a new
`(image-substring, probe_fn)` pair to extend it to another app.

The image match can be overridden per container — force one to be probed
as a specific app (a custom/renamed image, or to pick one instance if you
run more than one) or turn probing off for it — in **Settings →
Live-activity overrides**. Unlike the rest of Settings this is saved
server-side (`backend/service_activity_overrides.py`, `/data/
service_activity_overrides.json`, `GET`/`PUT
/api/service-activity-overrides`, included in every `/ws` tick), same
pattern as pins/todos, since it changes what the backend actually probes
— the same on every browser, not a per-browser display choice.

Any container with no answer from the above (unmatched image, no
credentials, or the API check failed) gets a fallback from
`backend/resource_activity.py`: an amber "busy" badge when its CPU or
network use spikes well above *its own* recent baseline — a fixed global
threshold doesn't work since normal load varies wildly between containers
(a monitoring agent parked at 20% CPU is unremarkable; qBittorrent
jumping from 0% to 20% is not). The baseline is an EWMA of CPU%/RX/TX,
updated every reconcile tick (~5s, in-memory only, not persisted) and
frozen while a spike is active so a sustained spike can't drag its own
baseline up and erase itself. No credentials needed, works for any
container — but it's a guess, not a confirmed answer (a backup job would
look "busy" too), hence the amber vs. green. Tunable via
`RESOURCE_ACTIVITY_CPU_FACTOR`/`_MIN_DELTA`/`NET_FACTOR`/`_MIN_BPS` (see
`.env.example`); toggle it off separately from the API-based badges in
**Settings**, or opt one container out entirely with a "Don't probe"
override (suppresses this fallback too, not just the API probe).

**Settings** holds per-browser display preferences (`localStorage`, not
synced across devices): the sparkline time window, whether container
uptime and live-activity badges show, which Overview cards are visible,
and per-pin group labels + web-UI links for Quick Actions (e.g. label
qBittorrent + Jellyfin "Media" to group them under one header there).

## History and sparklines

CPU, RAM, CPU temperature, and network cards carry a small trend line for
the last 30 minutes, sourced from Prometheus range queries
(`get_machine_history` in `backend/prometheus.py`). That query is re-run
at most once every 30s and cached — the `/ws` loop calls it every 2s like
everything else, but reuses the cached series in between instead of
re-hitting Prometheus every tick.

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
long-term record. Each container gets a
30-bucket heartbeat bar plus a recent uptime % (fraction of samples where
Docker reported it `running` and, if it has a healthcheck, not
`unhealthy`) — this is a passive read of container status already being
polled, not an active HTTP check the way Uptime Kuma monitors a URL.

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

## Alerting

Off unless `ALERT_WEBHOOK_URL` is set. When it is, `backend/alerts.py`
runs a loop every `ALERT_INTERVAL` seconds (default 60) over the same
fleet snapshot the scheduler uses and `POST`s a small JSON body to that
URL when something crosses a line — and again when it clears:

- a host Prometheus had `online` goes offline
- a host is up but its agent stops responding
- a host's RAM (`ALERT_RAM_PERCENT`, default 90) or CPU
  (`ALERT_CPU_PERCENT`, default 95) sits over threshold for
  `ALERT_BREACH_CYCLES` consecutive checks (default 2 — a single spike
  won't page you; host-offline and deployment failures fire on the first
  check)
- a scheduler-managed deployment goes `failed` or `node_offline`

Only state *changes* are sent, so a condition that stays true doesn't
repeat. The body is deliberately generic —
`{status: "firing"|"resolved", key, title, message, host, timestamp}` —
so it works with ntfy, Gotify, Discord, Slack-compatible webhooks,
healthchecks.io, or your own receiver. Transitions are also logged on the
`scheduler` logger.

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
