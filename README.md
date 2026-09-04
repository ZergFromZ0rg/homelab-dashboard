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

## Main System vs. Nodes

The machine the dashboard itself runs on gets its own full-width "Main
System" section at the top instead of being listed as just another node
in the "Nodes" grid below — auto-detected, no configuration needed:
Docker sets a container's `HOSTNAME` env var to its own short container
ID, and every agent already reports that same ID in its container list
(an agent lists every container on its host, dashboard-api included), so
the backend matches its own `HOSTNAME` against those lists on every
WebSocket tick. `MAIN_HOST` (Prometheus job / agent `HOST_NAME`) is only
needed as a manual override — e.g. the dashboard runs on a host with no
homelab-agent, so there's nothing for it to match against. Every
container list — the Main System's own, and each node's — is collapsible
and has its own independent sort control (name / CPU / RAM / status), so
sorting one doesn't reorder the others.

## History and sparklines

CPU, RAM, and network cards carry a small trend line for the last 30
minutes, sourced from Prometheus range queries (`get_machine_history` in
`backend/prometheus.py`). That query is re-run at most once every 30s and
cached — the `/ws` loop calls it every 2s like everything else, but reuses
the cached series in between instead of re-hitting Prometheus every tick.

## Run

```bash
cp .env.example .env   # adjust PROMETHEUS_URL / ALLOWED_ORIGINS / REGISTER_TOKEN / MAIN_HOST
docker compose up -d --build
```

Requires an external Docker network named `prometheus_default` (the
network your Prometheus container is on) — the compose file expects to
join it, not create it.

## API

- `GET /api/nodes` — registered agents (name, url, last_seen, stale)
- `POST /api/nodes` — agent self-registration, `{"name", "url"}`, gated by
  `X-Register-Token` when `REGISTER_TOKEN` is set
- `DELETE /api/nodes/{name}` — deregister a node
- `POST /api/containers/{host}/{container_id}/{start|stop|restart}` —
  proxies a control action to that host's agent
- `GET /ws` — WebSocket, pushes
  `{type, machines, containers, main_host, history}` every 2s
