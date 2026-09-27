# Roadmap

Where this is going: from a homelab dashboard to a **personal agent that
oversees the homelab and helps with daily life** — reads the fleet, runs
things overnight, talks to the local AI and the librarian, and lets you
build and test from one place.

Order matters. Each phase is useful on its own, and later phases lean on
earlier ones — the terminal and the AI are only safe once auth exists.

## Principles

- **Impeccable in use.** Dense, flat, fast. Details in tooltips, not text.
  Controls live on the thing they act on, not in a settings list.
- **Simple, powerful code; low resource use.** No new service unless it
  pays for itself. The core runs with every optional module switched off.
- **Optional modules.** AI, librarian, calendar, face features are add-ons
  with their own switch. Off = zero cost, zero UI.
- **Zero-setup defaults.** A feature that needs an `.env` edit or a label
  on every container is a cost — name it before building it.
- **Honest state.** Half-working shows as half-working (`unmatched`,
  `runtime_missing`), never as fine.
- **The AI proposes, you approve.** Nothing destructive runs without a tap.

## Status legend

`[x]` done · `[~]` partly there · `[ ]` not started

---

## Phase 0 — Already built

- [x] Fleet stats: CPU/RAM/disk/GPU/temps, heartbeat, 2 h graphs
- [x] Container table, restart/stop, pins, week of CPU/RAM history
- [x] Deploy + scheduler, compose stacks, rebalance, auto-rebalance
- [x] Join flow (`install.sh`), fleet-wide agent/dashboard rebuild
- [x] Config + volume backups with a proven restore
- [x] Service checks, alerts + webhook, activity feed, Attention panel
- [x] Disk explorer (folder sizes), networks tab
- [x] Overview: todos, notes, weather, calendar card

## Phase 1 — Impeccable core

### 1.1 Authentication (passkeys) — *done*
Everything powerful below (terminal, file edits, the AI running commands)
needs a real login first. Tailscale + a shared token was fine for a
read-mostly dashboard; it is not fine for a web shell.

- [x] Passkey (WebAuthn) login — Face ID / Touch ID / Windows Hello / phone
      via QR. The browser does the biometrics; the server stores only a
      public key.
- [x] Zero setup: open until the first passkey is added, then enforced.
- [x] Session cookie (HttpOnly, SameSite=Strict), 30-day sliding.
- [x] Manage passkeys in the settings drawer: add a device, rename, remove.
- [x] Recovery when every device is lost: one `docker exec` command.
- [x] Scripts/agents keep working via `X-Register-Token` (`API_TOKEN`).
- [x] HTTPS via `tailscale serve` (browsers only allow passkeys over
      HTTPS) — on, at `https://thinkpad.tail0179f8.ts.net`. Once a passkey
      exists, a page opened over plain http moves itself there.
- [x] Lock the agents: one shared `AGENT_TOKEN` on every node and the
      dashboard (2026-09-27). Direct calls without it get 401; the
      read-only container list stays open. New nodes get it through the
      Add-node command (`install.sh --agent-token`).
- [ ] Later: remove the old `TokenBox` from forms once sessions cover it.

### 1.2 Web terminal — *done*
- [x] xterm.js dock along the bottom (lazy-loaded, its own chunk);
      websocket → dashboard → agent → `docker exec` into a container, or a
      host shell (throwaway privileged helper, `nsenter` into PID 1, logged
      in as the owner of the agent's checkout).
- [x] Opened from the container row (`>_`) and the server card header.
- [x] Needs a passkey login — refuses while login is off — and every
      session goes on the activity feed with the passkey's name.
- [x] Agent side opt-in (`TERMINAL_ENABLED`, or `install.sh --terminal`).
- [x] Resize (drag the top edge), copy/paste (Ctrl+Shift+C on Linux),
      Enter to reconnect after an exit or a drop; several tabs; closing a
      tab hangs the shell up rather than leaving it running.
- [x] On for bigboy and thinkpad (2026-09-27); host shells log in as `zerg`.

### 1.3 File browser — *done*
- [x] The disk explorer grew into it: list (every name, sizes still from
      the background scan), open, view (text, images, video, audio, PDF),
      download (a folder as a streamed .tar.gz), upload (button or drop,
      with progress), rename, new folder, delete. Folder button in each
      server card header opens it at home; double-click the path to type one.
- [x] Config editor: CodeMirror, lazy — core only when a text file opens,
      each language only for its file type. ⌘S saves; a file changed on
      disk since it was opened is refused (reload or overwrite).
- [x] Writes scoped to roots per host: the agent owner's home + every
      compose stack folder, zero setup; more via `FILES_WRITABLE_PATHS`.
      Reading stays everywhere. Writes run in a helper **as the file's
      owner** (no root-owned files) and keep the inode (single-file bind
      mounts see edits).

### 1.4 Container settings — edit the compose file, not the container — *built*
Stacks live in `compose.yml` on each host; editing a running container
directly gets silently undone by the next `docker compose up`.
- [x] Container row → sliders icon opens a wide panel with its stack's
      compose file (the file that defines the service, if there are several).
- [x] Settings tab for image / restart / environment / ports / volumes —
      each edit rewrites only its own line (comments and quotes stay);
      YAML tab for everything else.
- [x] Review = `docker compose config` on a copy + diff → Apply = save (as
      the file's owner) → `up -d` → watch → automatic rollback if a
      container exits non-zero, restart-loops or turns unhealthy. Every
      apply and its outcome go on the activity feed.
- [x] Needs "Allow rebuilds and compose changes" (`REBUILD_ENABLED`); the
      agent's own stack is refused (it would stop mid-job).
- [x] Containers not from compose: read-only generated compose file, copy
      or save into a stack folder; switching over stays manual.

### 1.5 Updates
- [ ] Image update checks: compare the local digest to the registry's,
      badge on the container row ("update available").
- [ ] One-click update per container / stack (pull + recreate + health
      watch + rollback), and "update all" per host.
- [ ] Optional nightly update window, off by default.
- [ ] Keep the existing agent/dashboard rebuild as is.

### 1.6 Polish and weight
- [ ] Command palette (⌘K): jump to any host, container, tab, action.
- [ ] Mobile layout pass — this becomes the thing you open on your phone.
- [ ] Resource budget: measure dashboard + agent RAM/CPU idle, keep it
      in the README, fail review when it grows without a reason.
- [ ] Browser first-run wizard (after `setup.sh`).
- [ ] Split `main.py` routes into routers like `scheduler_api.py`.

## Phase 2 — The AI overseer

### Hardware reality check
Local AI today = bigboy's **GTX 1650 SUPER, 4 GB VRAM**: good for 3–4B
models, a squeezed 7B. Fine for summaries, triage, "why is bigboy hot".
Not enough for overnight coding. Decide:
1. Hybrid — small local model for routine/private work, a cloud model for
   heavy building. *(recommended to start)*
2. A bigger GPU (used 3090, 24 GB).
3. Keep the AI to observe-and-summarize.

### 2.1 Foundation (read-only)
- [ ] `backend/ai/` module, off unless configured. Model provider is
      pluggable: Ollama / llama.cpp (OpenAI-compatible) or a cloud API.
- [ ] Tools = the dashboard's own API: fleet, containers, logs, history,
      alerts, activity, backups, disk. Read tools are free to call.
- [ ] Chat panel (drawer, like settings) with streamed answers and the
      tool calls shown inline.
- [ ] "Explain this" buttons: on an alert, a container, a host.

### 2.2 Actions with approval
- [ ] Action tools: restart, deploy, update, run a command, edit a file.
- [ ] Every action = a proposal card with exactly what will run → approve
      / reject. Logged to the activity feed with `by: ai`.
- [ ] Per-action allowlist to loosen approval for safe things later.

### 2.3 Overnight jobs and the morning report
- [ ] Job queue (persisted in `/data`), schedule windows, per-job budgets.
- [ ] Jobs: ingest documents, check updates, investigate restarts,
      summarize the day's alerts, verify backups.
- [ ] Morning report card on Overview: what happened, what needs a yes.
- [ ] Push notifications (webhook exists; add ntfy/phone push).

### 2.4 Proactive insight
- [ ] Daily digest: disk trends, flapping containers, stale backups.
- [ ] Anomaly notes attached to alerts ("started after the 02:00 update").

## Phase 3 — Daily life

- [ ] **Librarian integration** — ingest documents from the to-do list /
      a drop folder, search it as an AI tool. *Need: what the librarian is,
      its API, where it runs.*
- [ ] Calendar — two-way (CalDAV/Google), agenda on Overview, AI can read
      it and propose events.
- [ ] To-dos the AI can read, add to, and work through overnight.
- [ ] Notes ↔ librarian: notes become searchable knowledge.
- [ ] Voice/phone: installable PWA, share-sheet "send to agent".

## Phase 4 — Build from here

- [ ] Workspace: pick a repo on a host, terminal + editor + AI side by side.
- [ ] "Build me X": the AI scaffolds a project in a sandbox container,
      runs it, shows a preview URL, deploys it via the existing scheduler.
- [ ] Test runs and logs streamed into the UI.
- [ ] Sandboxes are throwaway containers with resource limits; nothing
      touches the host outside its folder.

## Phase 5 — Extras

- [ ] Custom face recognition — as a *feature* (who's at the camera,
      presence for automations), not as the login lock: without depth and
      liveness checks a photo can fool it. Passkeys already give a
      face-based login backed by real hardware security.
- [ ] Home Assistant bridge.
- [ ] Multi-user (household) with roles, if anyone else will use it.

## Open questions

- What is the AI librarian — API, storage, which host?
- Which local runtime (Ollama? llama.cpp?) and model, on which machine?
- Just you, or others in the household?
- Ever reached from outside the tailnet?
