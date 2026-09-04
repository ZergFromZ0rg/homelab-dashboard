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

Set `MAIN_HOST` to the Prometheus job / agent `HOST_NAME` of the machine
this dashboard itself runs on, and the frontend gives that machine its own
full-width section at the top ("Main System") instead of listing it as
just another node in the "Nodes" grid below. Leave it unset and every
machine renders the same way. Containers can be sorted (name / CPU / RAM /
status) via the control in the header — the same sort applies to the Main
System's own container list and every node's, and each node's container
list is collapsible independently.

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
- `GET /ws` — WebSocket, pushes `{type, machines, containers}` every 2s
