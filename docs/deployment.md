# Deployment guide

This walks through standing up the whole system from nothing: Prometheus
scraping your hosts, the dashboard, and an agent on each machine. At the
end you'll have a working dashboard and be able to deploy a container to
the best node from the browser.

## What you're deploying

Three pieces:

- **Prometheus + node_exporter** — one node_exporter per host, scraped by a
  Prometheus you already run or set up here. This is where host CPU / RAM /
  disk / temperature come from.
- **The dashboard** — one instance, anywhere. Two containers: a FastAPI
  backend and an nginx that serves the frontend and proxies to the
  backend.
- **An agent** (`homelab-agent`) — one per host. Reports that host's
  containers and GPU, and runs the scheduler's deploy/stop/remove
  commands. It talks to the host's Docker socket.

The agent's `HOST_NAME` must match the Prometheus job name for the same
machine. That's the only thing tying the two data sources together.

## Prerequisites

- Docker and the compose plugin on the dashboard host and every agent
  host.
- A private network the pieces can reach each other on. A LAN is fine; a
  Tailscale/WireGuard tailnet is better and is assumed below for anything
  security-sensitive.
- Git, to clone the two repos.

---

## Step 1 — Prometheus and node_exporter

Skip the Prometheus part if you already run one.

### node_exporter on every host

Run it on each machine you want to see, including the one the dashboard
runs on:

```bash
docker run -d \
  --name node-exporter \
  --restart unless-stopped \
  --net host \
  --pid host \
  -v /:/host:ro,rslave \
  quay.io/prometheus/node-exporter:latest \
  --path.rootfs=/host \
  --collector.cpu.info \
  --collector.hwmon
```

`--collector.cpu.info` gives you the real CPU model in the UI;
`--collector.hwmon` gives you temperatures. node_exporter listens on
`:9100`.

### Prometheus scrape config

Add one job per host. **The `job_name` is the name that host shows up as
everywhere** — in the dashboard, and as the agent's `HOST_NAME`. Pick
something stable and human (`thinkpad`, `nuc-media`, `nas`).

```yaml
scrape_configs:
  - job_name: thinkpad
    static_configs:
      - targets: ["100.64.0.1:9100"]   # that host's address
  - job_name: nuc-media
    static_configs:
      - targets: ["100.64.0.2:9100"]
```

Reload Prometheus (`docker kill -s SIGHUP prometheus`, or restart it) and
check **Status → Targets** — every job should be `UP`.

If you're setting Prometheus up from scratch, the smallest thing that
works:

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: thinkpad
    static_configs:
      - targets: ["host.docker.internal:9100"]
```

```bash
docker run -d --name prometheus --restart unless-stopped \
  -p 9090:9090 \
  -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus:latest
```

---

## Step 2 — The dashboard

```bash
git clone https://github.com/ZergFromZ0rg/homelab-dashboard.git
cd homelab-dashboard
cp .env.example .env
```

Edit `.env`. The two that matter for a first run:

```ini
# How the backend reaches Prometheus. See the network note below.
PROMETHEUS_URL=http://prometheus:9090

# The URL you'll load the dashboard from, so CORS and the WebSocket work.
ALLOWED_ORIGINS=http://dashboard-host:8081
```

Leave the tokens blank for now — you'll set them in step 4 before turning
on deploys.

### The Prometheus network

`compose.yml` joins an external Docker network called `prometheus_default`
so the backend can reach Prometheus by container name. That name is
Compose's default for a project directory called `prometheus/`. Two cases:

- **Prometheus runs in Docker on this host.** Find its network with
  `docker network ls`. If it's not `prometheus_default`, edit the bottom
  of `compose.yml`:

  ```yaml
  networks:
    prometheus_net:
      external: true
      name: <the actual network>
  ```

  and set `PROMETHEUS_URL` to `http://<prometheus-container-name>:9090`.

- **Prometheus is elsewhere** (another host, a VM, not in Docker). Delete
  the `prometheus_net` network from `compose.yml` (remove it from the
  `dashboard-api` service and from the `networks:` block), and set
  `PROMETHEUS_URL` to a reachable address like
  `http://100.64.0.1:9090`.

### Bring it up

```bash
docker compose up -d --build
```

Load `http://dashboard-host:8081`. The header should say **LIVE**. The
Nodes grid will be empty until agents register — that's step 3.

The `dashboard-data` volume holds the node registry, the deployment
records, and short-term history. Don't delete it unless you mean to.

---

## Step 3 — An agent on every host

On each machine (including the dashboard host):

```bash
git clone https://github.com/ZergFromZ0rg/homelab-agent.git
cd homelab-agent
docker build -t homelab-agent .
```

The build pulls the Docker CLI and Compose plugin into the image (needed
for compose-stack deploys), so it's a few hundred MB and takes a minute.

Run it. Replace `thinkpad` with this host's Prometheus job name, and
`http://dashboard-host:8081` with your dashboard's URL:

```bash
docker run -d \
  --name homelab-agent \
  --restart unless-stopped \
  -p 8123:8123 \
  -e HOST_NAME=thinkpad \
  -e DASHBOARD_URL=http://dashboard-host:8081 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v homelab-agent-data:/data \
  homelab-agent
```

- `HOST_NAME` **must** match the Prometheus `job_name` for this machine.
- `DASHBOARD_URL` lets the agent register itself — no dashboard-side config
  when you add a host.
- `/data` holds compose-stack project files; keep it on a volume.
- On an NVIDIA host, add `--gpus all` for GPU telemetry.

Within a few seconds the host appears in the dashboard's Nodes grid, with
host stats from Prometheus and a container list from the agent.

Repeat for every host. Each new one is just this command plus a Prometheus
scrape job — nothing on the dashboard changes.

---

## Step 4 — Turn on deploys, safely

Everything above is read-only monitoring. The Deploy tab — where the
scheduler places containers on your hosts — is a remote-code-execution
surface, so set it up deliberately.

### The two tokens

There are two, going in opposite directions. Use two different random
strings (`openssl rand -hex 16`).

| Token | Set on | Also set on | Protects |
| --- | --- | --- | --- |
| **API token** | dashboard `.env` as `API_TOKEN` | every agent as `REGISTER_TOKEN` | agents registering with the dashboard, and the dashboard's own mutating API |
| **Agent token** | dashboard `.env` as `AGENT_TOKEN` | every agent as `AGENT_TOKEN` | the dashboard calling agents to create / remove containers |

Dashboard `.env`:

```ini
API_TOKEN=<random string 1>
AGENT_TOKEN=<random string 2>
```

Each agent gets both, as env vars on the `docker run`:

```bash
  -e REGISTER_TOKEN=<random string 1> \
  -e AGENT_TOKEN=<random string 2> \
```

`docker compose up -d` the dashboard and recreate the agents to pick these
up.

### Lock down the agent's network position

The agent talks to Docker as root. Its port (`8123`) must be reachable
**only** over your trusted overlay, never a plain LAN or the internet.
Bind it to the tailnet interface instead of `0.0.0.0`:

```bash
  -p 100.64.0.1:8123:8123 \
```

### Decide what the agent will allow

By default the agent runs containers with **named volumes only** and
**any registry**. Tighten as needed with env vars on the agent:

```bash
  -e ALLOWED_REGISTRIES=docker.io,lscr.io,ghcr.io \
  -e ALLOWED_HOST_PATHS=/srv/appdata \
  -e ALLOWED_DEVICES=/dev/dri \
```

- `ALLOWED_HOST_PATHS` — bind mounts are refused unless the host path is
  under one of these. Only list directories your deployed containers
  **can't write to** — a writable allowed directory lets a container plant
  a symlink and escape it later.
- `ALLOWED_DEVICES` — device passthrough (GPU/QSV transcode needs
  `/dev/dri`) is refused unless listed.
- Compose stacks are checked against a service-key allowlist; `privileged`,
  host namespaces, `security_opt`, `volumes_from`, and similar are
  rejected. Full list in the agent README's Security section.

### Try it

Deploy tab → an image like `traefik/whoami:latest`, a host port, **Preview
placement**, then **Deploy to \<node\>**. It should land, and the card
shows a `created` → `deployed` event trail. Remove it with the Remove
button.

---

## Step 5 — Auto-rebalance (optional)

With this off (the default), the dashboard *suggests* moving a container
off an overloaded node and you click to apply. With it on, the backend
does qualifying moves itself.

It only ever moves **stateless single containers** (no volumes, not a
stack), and it's deliberately cautious. Start conservative:

```ini
AUTO_REBALANCE=1
AUTO_REBALANCE_MIN_GAIN=30        # placement-score points the new node must beat the old by
AUTO_REBALANCE_MAX_PER_CYCLE=1    # moves per check
AUTO_REBALANCE_INTERVAL=600       # seconds between checks
AUTO_REBALANCE_COOLDOWN=3600      # per-deployment, so a flapping node can't cause a storm
```

The same loop reschedules a stateless container off a node that has gone
fully offline, onto a healthy one. A move whose target rejects the
container rolls back to where it was.

Watch what it does before trusting it:

```bash
docker compose logs -f dashboard-api | grep ' scheduler '
```

---

## Logs

Both sides log to stdout.

```bash
# every placement decision — deploy, move, reschedule, fail, recover
docker compose logs dashboard-api | grep ' scheduler '

# every container/stack operation asked of a host, and every policy rejection
docker logs homelab-agent | grep ' audit '
```

`LOG_LEVEL=DEBUG` on either side adds the noisy stuff (unreachable peers,
per-container stat errors).

---

## Updating

```bash
# dashboard
cd homelab-dashboard && git pull && docker compose up -d --build

# each agent host
cd homelab-agent && git pull && docker build -t homelab-agent . \
  && docker rm -f homelab-agent && <your docker run command>
```

The `dashboard-data` and `homelab-agent-data` volumes survive a rebuild,
so deployment records and stack files carry over.

---

## Troubleshooting

**Header says DISCONNECTED.** The browser can't open the WebSocket. Check
`ALLOWED_ORIGINS` matches the exact scheme+host+port you're loading from,
and that nothing between you and the dashboard strips WebSocket upgrades.

**A host shows containers but no CPU/RAM (or vice versa).** The agent's
`HOST_NAME` and the Prometheus `job_name` don't match. They must be
identical.

**Deploy fails with "agent rejected".** Read the error on the card. If
it's about a missing route, that agent is running an old build — rebuild
it. If it's a policy rejection (bind mount, registry, a compose key), it's
telling you exactly what it didn't like.

**Deploy fails with "agent unreachable".** The dashboard can't reach the
agent at the URL it registered. Check `AGENT_URL` on the agent — set it
explicitly to the address the dashboard should use (`-e
AGENT_URL=http://100.64.0.1:8123`) if the hostname doesn't resolve from
the dashboard.
