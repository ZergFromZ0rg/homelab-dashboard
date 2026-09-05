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

## Layout

Two tabs: **Server Overview** (default) shows host stats only — the Main
System panel plus the Nodes grid. **Containers** shows every host's
containers in one place, grouped and collapsible per host, each group
with its own independent sort control (name / CPU / RAM / status).

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

## History and sparklines

CPU, RAM, CPU temperature, and network cards carry a small trend line for
the last 30 minutes, sourced from Prometheus range queries
(`get_machine_history` in `backend/prometheus.py`). That query is re-run
at most once every 30s and cached — the `/ws` loop calls it every 2s like
everything else, but reuses the cached series in between instead of
re-hitting Prometheus every tick.

GPU temperature and each container's up/down status don't come from
Prometheus at all (GPU is agent-reported, container status is a live
Docker snapshot), so `backend/live_history.py` keeps its own 30-minute
rolling buffer, sampled once per `/ws` tick and persisted to
`/data/live_history.json` (same volume as the node registry) at most
once every 30s — so redeploying the dashboard doesn't wipe history for
containers that never actually restarted. Keyed by `(host, container_id)`
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
   same stats the dashboard already streams; no LLM involved in the
   decision.
2. `backend/llm.py` (only when `ANTHROPIC_API_KEY` is set) turns the
   free-text "notes" field into structured constraints and writes a short
   rationale. It never changes the ranking.
3. The backend `POST`s the chosen node's agent at `POST {agent}/containers`
   to pull and run the image, and records the deployment in
   `/data/deployments.json`. The `/ws` loop reconciles each record's
   status against the live container list every tick.

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

Not in scope: compose stacks, automatic rescheduling when a node dies
(there's a manual "redeploy elsewhere" button), cross-node networking, and
stateful volume migration (a named volume stays on its node).

## Run

```bash
cp .env.example .env   # adjust PROMETHEUS_URL / ALLOWED_ORIGINS / API_TOKEN / MAIN_HOST / ANTHROPIC_API_KEY
docker compose up -d --build
```

Backend tests: `pip install -r backend/requirements-dev.txt && python -m pytest backend/tests`

Requires an external Docker network named `prometheus_default` (the
network your Prometheus container is on) — the compose file expects to
join it, not create it.

## API

All mutating routes are gated by the `X-Register-Token` header when
`API_TOKEN` (alias: `REGISTER_TOKEN`) is set.

- `GET /api/nodes` — registered agents (name, url, last_seen, stale)
- `POST /api/nodes` — agent self-registration, `{"name", "url"}`
- `DELETE /api/nodes/{name}` — deregister a node
- `POST /api/containers/{host}/{container_id}/{start|stop|restart}` —
  proxies a control action to that host's agent
- `POST /api/deployments` — body is a `DeploymentSpec`. `?dry_run=1`
  returns the scored ranking without deploying; otherwise it deploys to
  the top node (or `?node=<name>` to override to another eligible node)
  and returns the `DeploymentRecord`.
- `GET /api/deployments` / `GET /api/deployments/{id}` — managed deployments
- `GET /api/rebalance` — `{suggestions, checked_at}`; stateless managed
  containers on an overloaded node that would score better elsewhere
- `POST /api/deployments/{id}/redeploy` — re-score and move it
  (`?exclude_current=1` by default keeps it off its current node)
- `DELETE /api/deployments/{id}` — remove the record and, unless
  `?keep_container=1`, tell the agent to delete the container
- `GET /ws` — WebSocket, pushes
  `{type, machines, containers, main_host, history, deployments}` every 2s
