# AI Scheduler MVP — implementation plan

Turn the dashboard from a read-only monitor into a control plane: submit a
container spec through the web UI, a scheduler picks the best node, the
dashboard tells that node's agent to pull and run it. An LLM layer sits on
top for natural-language constraints and human-readable placement
reasoning — but the placement decision itself is a deterministic scorer.

## Status (2026-09-05)

All seven milestones merged to `main` in both repos. Agent `POST
/containers` + `DELETE /containers/{id}` in `homelab-agent/deploy.py` with
a policy layer (`AGENT_TOKEN`, `ALLOWED_REGISTRIES`, `ALLOWED_HOST_PATHS`),
verified end-to-end against a real Docker daemon. Dashboard: `scheduler.py`
(incl. host-port-conflict filter), `deployments.py`, `llm.py`, the
`/api/deployments` routes, the Deploy tab, a "scheduled" badge on managed
containers.

Beyond the MVP, also merged: `backend/rebalance.py` + `GET /api/rebalance`
+ the Deploy tab's Rebalancing panel — re-scores stateless managed
containers on an overloaded node and suggests moves (advisory; "Move" runs
redeploy). 52 tests across the two repos.

**Compose stacks** (also merged): Deploy tab "Compose stack" mode →
`backend/compose.py` (per-service parse) + `backend/stacks.py` (one
synthetic placement spec from summed limits / unioned ports, `pinned`) →
`POST /api/stacks` → agent `POST /stacks` runs `docker compose up -d`
(agent image now ships the Compose plugin). Named volumes only, `build:`
rejected. Reconcile/redeploy/delete are kind-aware
(`DeploymentRecord.kind`). Verified end to end through the browser against
real Docker.

**Auto-rebalance + event log** (also merged): every `DeploymentRecord`
carries an `events` timeline (`created`/`deployed`/`failed`/`recovered`/
`moved`, `moved` flagged `automatic` for a rebalancer move), populated in
the deploy paths and `reconcile`. `AUTO_REBALANCE=1` turns on
`backend/autorebalance.py` — a lifespan background loop that executes
suggestions clearing a higher gain bar, one per cycle, with a
per-deployment cooldown. `GET /api/rebalance` echoes `auto`; the Deploy
tab shows an "auto on" badge and the event timeline per card.

Not done: production hardening beyond the shared tokens, stateful volume
migration, cross-node stack networking.

## Scope

**In:**

- Deploy a **single container** (image, env, ports, volumes, restart
  policy, resource limits, optional constraints) from a form.
- Deterministic scoring of every registered node against the spec's
  resource request + constraints.
- Optional LLM pass: parse a free-text requirement into a constraint set,
  and explain the ranking.
- A persistent record of what was deployed where (`deployments.json` on
  the existing `/data` volume).
- Show deployment status (running / failed / node offline) alongside the
  existing container list.

**Out (explicitly, for the MVP):**

- Compose / multi-container stacks.
- Automatic rescheduling when a node dies. (Record it, surface it, let the
  user click "redeploy elsewhere" — no autonomous migration.)
- Cross-node networking / overlay / service discovery. Ports are published
  on the chosen host; that's it.
- Stateful volume migration. A named volume stays on its node; rescheduling
  a stateful container is a user decision with a visible warning.
- Learning resource needs from observation. The user supplies limits, or
  we use a lookup table for well-known images, or we default and warn.

## Architecture

```
┌─────────────┐   POST /api/deployments        ┌──────────────────┐
│  frontend   │ ─────────────────────────────▶ │  dashboard-api   │
│  Deploy tab │   {image, env, ports, ...,     │                  │
└─────────────┘    constraints, dry_run}       │  scheduler.py    │
                                                │   • gather node  │
                                                │     stats (reuse │
                                                │     prometheus)  │
                                                │   • score nodes  │
                                                │   • (LLM explain)│
                                                │  deployments.py  │
                                                │   • persist spec │
                                                └────────┬─────────┘
                                                         │ POST {agent_url}/containers
                                                         ▼
                                                ┌──────────────────┐
                                                │  homelab-agent   │  ← NEW endpoint
                                                │  on chosen node  │     (other repo)
                                                │   • docker pull  │
                                                │   • docker run   │
                                                └──────────────────┘
```

Nothing about the WebSocket loop or Prometheus path changes. The scheduler
reuses `get_machine_stats()` output as its fact base.

---

## 1. homelab-agent changes (separate repo — the critical path)

The agent currently exposes `/containers` (GET) and
`/containers/{id}/{start|stop|restart}` (POST). Add one endpoint.

### `POST /containers` — create and run a container

Request body:

```jsonc
{
  "image": "lscr.io/linuxserver/jellyfin:latest",
  "name": "jellyfin",                 // optional; agent generates if absent
  "env": { "PUID": "1000", "TZ": "UTC" },
  "ports": [ { "container": 8096, "host": 8096, "proto": "tcp" } ],
  "volumes": [ { "source": "jellyfin-config", "target": "/config" } ],
  "restart_policy": "unless-stopped", // no | on-failure | always | unless-stopped
  "resources": { "cpus": 2.0, "memory_mb": 2048 },
  "labels": { "deployed-by": "homelab-dashboard" },
  "pull": true
}
```

Response:

```jsonc
// 201
{ "success": true, "id": "3f2a1b...", "name": "jellyfin", "image_digest": "sha256:..." }
// 4xx / 5xx
{ "success": false, "error": "pull failed: manifest unknown", "stage": "pull" }
```

Implementation notes:

- Use the Docker SDK (`docker.from_env().containers.run(..., detach=True)`)
  or shell out to `docker run`. SDK is cleaner for structured errors.
- **Pull with a timeout** (images are large; 5 min is reasonable). Return
  `stage: "pull"` vs `stage: "create"` vs `stage: "start"` so the caller
  can tell the user what went wrong.
- **Name collision**: 409 if a container with that name exists. Don't
  silently replace.
- Map `resources.cpus` → `nano_cpus`, `memory_mb` → `mem_limit`.
- Apply the `deployed-by` label so the dashboard can distinguish
  scheduler-managed containers from hand-run ones.

### Policy guardrails (do this before exposing the endpoint anywhere)

Add an agent-side allow/deny config (env or a mounted YAML):

- **Reject** `privileged`, `cap_add`, `--pid=host`, `--network=host`,
  arbitrary bind mounts of host paths (allow named volumes + a configured
  allowlist of host dirs only), `/var/run/docker.sock` mounts.
- Optional image registry allowlist (`lscr.io`, `docker.io/library`, ...).
- The endpoint must require the shared token (see Security below) —
  `start/stop/restart` should start requiring it too.

### Effort: 2–4 days including the guardrails and error mapping.

---

## 2. dashboard-api changes (this repo)

### `backend/models.py` — fill in (currently empty)

Pydantic models: `PortMapping`, `VolumeMapping`, `ResourceRequest`,
`Constraints`, `DeploymentSpec`, `DeploymentRecord`, `PlacementResult`.

```python
class Constraints(BaseModel):
    require_gpu: bool = False
    node_in: list[str] | None = None          # only these nodes
    node_not_in: list[str] | None = None       # never these nodes
    max_node_cpu_percent: float | None = None  # don't place on a node already hotter than this
    notes: str | None = None                   # free text -> LLM turns this into the above

class DeploymentSpec(BaseModel):
    image: str
    name: str | None = None
    env: dict[str, str] = {}
    ports: list[PortMapping] = []
    volumes: list[VolumeMapping] = []
    restart_policy: Literal["no","on-failure","always","unless-stopped"] = "unless-stopped"
    resources: ResourceRequest = ResourceRequest()   # cpus, memory_mb, both optional
    constraints: Constraints = Constraints()
```

### `backend/scheduler.py` — new

```python
def score_nodes(spec: DeploymentSpec, machines: dict, containers: dict) -> list[PlacementResult]:
    """Return every eligible node with a 0–100 score and a reason list,
    best first. Ineligible nodes are included with score=0 and the
    disqualifying reason, so the UI can show 'why not'."""
```

Scoring, per node:

| Step | Rule |
|---|---|
| **Hard filters** (score 0, excluded) | node offline; `require_gpu` and no GPU; `node_in`/`node_not_in` violated; free RAM < `resources.memory_mb`; free disk < image est.; CPU already above `max_node_cpu_percent` |
| **Fit score** | `free_ram_after = ram_total*(1-ram/100) - memory_mb`; `free_cpu_after = cores*(1-cpu/100) - cpus`. Prefer the node with the *most* headroom left after placement (worst-fit — spreads load), unless `spec` opts into bin-pack. |
| **Penalties** | GPU node but container doesn't need GPU (−15, keep GPU nodes free for GPU work); node temp high (−10 if CPU temp > 75 °C); node marked stale (−20) |
| **Tie-break** | fewest scheduler-managed containers already on it |

Inputs are exactly what `get_machine_stats()` + the agent GPU data
already produce. Free RAM/CPU come from `ram_total_bytes`, `ram`, `cpu`,
`cpu_cores`. Disk from `filesystems`. No new metrics needed.

Image size estimate: default 500 MB; small lookup table for common bases;
or `HEAD` the registry manifest if you want to be precise (optional).

### `backend/llm.py` — new, optional (feature-flagged by `ANTHROPIC_API_KEY`)

Two functions, each **one** `claude-sonnet-5` call:

1. `parse_constraints(notes: str, node_names: list[str]) -> Constraints`
   — "keep it off the noisy server, it needs the GPU" →
   `{require_gpu: true, node_not_in: ["nuc-loud"]}`. Pass the node list so
   it can resolve nicknames. Validate the result against the Pydantic
   model; on any parse failure fall back to empty constraints + a warning.
2. `explain_placement(spec, ranked: list[PlacementResult]) -> str` — 2–3
   sentence rationale for the top pick vs the runner-up. Pure text, shown
   in the UI. Never let it change the ranking — it explains, it doesn't
   decide.

Keep the raw scores authoritative. If the API key is absent, the feature
degrades to: structured constraints only (from the form checkboxes), no
prose explanation. Everything still works.

### `backend/deployments.py` — new

Same pattern as `registry.py` / `live_history.py`: a lock-guarded dict
persisted to `/data/deployments.json`.

```python
DeploymentRecord = {
  "id": "uuid",
  "spec": {...},
  "placed_on": "nuc-1",
  "agent_container_id": "3f2a1b...",
  "status": "running | failed | placing | node_offline",
  "score": 82.0,
  "alternatives": [{"node": "nuc-2", "score": 74.0}, ...],
  "reason": "nuc-1 has 11 GB RAM free vs nuc-2's 4 GB; neither has a GPU.",
  "created_at": 0, "updated_at": 0, "error": null
}
```

### New API endpoints (`backend/main.py`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/deployments` | body `DeploymentSpec` + `?dry_run=1`. Dry run → score + explain, persist nothing. Real → pick top node, `POST {agent}/containers`, persist record, return it. |
| `GET` | `/api/deployments` | list records (drives the new UI tab) |
| `GET` | `/api/deployments/{id}` | one record |
| `POST` | `/api/deployments/{id}/redeploy` | re-score (optionally excluding the current/failed node), deploy again |
| `DELETE` | `/api/deployments/{id}` | proxy `stop`+`rm` to the agent (needs an agent `DELETE /containers/{id}`), drop the record |
| `POST` | `/api/schedule/preview` | thin alias for `dry_run` — score a spec without the deploy button |

Wire deployment status into the existing `/ws` payload: for each record,
match `agent_container_id` against the live container list the loop
already fetches, and set `status` accordingly (`running`, or
`node_offline` if that host is unreachable, or keep `failed`). No new
polling — it's a join on data already in the loop.

### Effort: 3–5 days (models + scheduler + deployments + endpoints + ws join). LLM layer +1 day.

---

## 3. frontend changes (this repo)

- **New tab** `Deploy` next to Server Overview / Containers
  ([App.jsx:86](../frontend/src/App.jsx)).
- **Deploy form** component:
  - image, name, env (key/value rows), ports (rows), volumes (rows),
    restart policy (select), CPU limit, memory limit.
  - constraints: "requires GPU" checkbox, node include/exclude
    multiselect (populated from `machines` keys), free-text notes box.
  - **"Preview placement"** button → `POST /api/deployments?dry_run=1` →
    renders the ranked node list with scores, per-node reasons, the
    disqualified nodes greyed with their reason, and the LLM explanation
    if present.
  - **"Deploy to {top node}"** button (with an override dropdown to pick a
    lower-ranked node manually) → real `POST /api/deployments`.
- **Deployments list** (either its own tab or a section in the Deploy
  tab): each record with status dot, node, score, reason, redeploy /
  remove buttons. Reuse `StatusDot`, the container-row styling.
- Extend the `/ws` handler to store `data.deployments` in state
  ([App.jsx:57](../frontend/src/App.jsx)).

### Effort: 3–5 days for a clean version of the form + preview + list.

---

## 4. Security (do not skip — this is a remote-code-execution service)

The MVP is only safe on a trusted network (LAN / Tailscale / WireGuard).
Even there:

1. **Make `REGISTER_TOKEN` mandatory** for all mutating routes — node
   register/delete, container control, **and** the new deploy routes.
   Rename it `API_TOKEN` since it's no longer just registration. Frontend
   sends it (injected at build, or a login box that stores it in
   `sessionStorage`).
2. **Agent-side policy allowlist** (§1) is the real containment boundary —
   the dashboard is not a trusted input source once it has a deploy
   button.
3. Agent endpoints bind to the private interface / Tailscale IP only,
   never `0.0.0.0` on a routable interface.
4. Log every deploy (who/what/where/when) to `deployments.json` — it
   doubles as an audit trail.
5. `ALLOWED_ORIGINS` already scopes CORS; keep it tight.

Not in the MVP but note for later: per-user auth, RBAC, signed specs,
rate limiting.

---

## 5. Milestones

1. **Agent `POST /containers`** + policy guardrails + token enforcement.
   Test with `curl`. *(Nothing in the dashboard yet.)*
2. **`scheduler.py` + `models.py`** with a unit test: feed it fake
   `machines` dicts, assert the ranking. No I/O.
3. **`deployments.py` + `POST /api/deployments` (dry_run only)**. Preview
   works end to end, deploys nothing.
4. **Real deploy path**: dry_run=0 → agent call → persist → `/ws` status
   join.
5. **Frontend**: form → preview → deploy → list.
6. **LLM layer**: `parse_constraints` + `explain_placement`, feature-flagged.
7. **redeploy / remove**.

Stop after any milestone and you still have something coherent. After 3
you have an "AI placement advisor" with no execution risk — a good place
to pause and use it for a while before turning on the deploy button.

## Total effort

~2–3 weeks of focused work for milestones 1–6. The agent endpoint and the
frontend form are the two biggest chunks; the scheduler itself is a day.

## Files touched

**New:** `backend/scheduler.py`, `backend/deployments.py`, `backend/llm.py`,
`frontend/src/components/DeployForm.jsx`,
`frontend/src/components/PlacementPreview.jsx`,
`frontend/src/components/DeploymentList.jsx`.

**Modified:** `backend/models.py` (empty → models), `backend/main.py`
(routes + ws payload), `backend/requirements.txt` (`anthropic`),
`frontend/src/App.jsx` (tab + ws state), `compose.yml` + `.env.example`
(`API_TOKEN`, `ANTHROPIC_API_KEY`), `README.md`.

**Separate repo (homelab-agent):** `POST /containers`,
`DELETE /containers/{id}`, policy config, token enforcement.
