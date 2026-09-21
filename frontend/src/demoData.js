// Dev-only fixture: `npm run dev` then open /?demo to preview the UI with a
// realistic fleet and no backend. Never bundled into a production build
// (App.jsx only references it behind import.meta.env.DEV).

export const DEMO =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");

const now = () => Date.now() / 1000;

function series(base, wobble, n = 120) {
  const t0 = now() - n * 60;
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * 60,
    v: Math.max(0, base + Math.sin(i / 7) * wobble + Math.cos(i / 3) * wobble * 0.4),
  }));
}

function heartbeat(downAt = []) {
  const buckets = Array.from({ length: 120 }, (_, i) =>
    downAt.includes(i) ? "down" : "up"
  );
  return { buckets, bucket_seconds: 60, uptime_percent: 100 - downAt.length };
}

function container(id, name, image, host, o = {}) {
  return {
    id,
    name,
    image,
    status: o.status ?? "running",
    health: o.health ?? null,
    started_at: new Date(Date.now() - (o.upHours ?? 72) * 3600_000).toISOString(),
    restart_count: o.restarts ?? 0,
    ports: o.ports ?? {},
    compose_project: o.project ?? null,
    deployed_by: o.deployedBy ?? null,
    stats: {
      cpu_percent: o.cpu ?? 1.2,
      memory: {
        used_bytes: (o.ramMb ?? 120) * 1024 * 1024,
        limit_bytes: o.limitMb ? o.limitMb * 1024 * 1024 : 0,
        percent: o.limitMb ? Math.round(((o.ramMb ?? 120) / o.limitMb) * 100) : 0,
      },
      network: {
        rx_bps: o.rx ?? 4200,
        tx_bps: o.tx ?? 1800,
        rx_bytes: (o.rxGb ?? 3.2) * 1024 ** 3,
        tx_bytes: (o.txGb ?? 0.8) * 1024 ** 3,
      },
      block_io: {
        read_bps: o.rd ?? 0,
        write_bps: o.wr ?? 12000,
        read_bytes: (o.rdGb ?? 1.1) * 1024 ** 3,
        write_bytes: (o.wrGb ?? 0.4) * 1024 ** 3,
      },
    },
    size: { image_bytes: (o.imgMb ?? 210) * 1024 * 1024, rootfs_bytes: (o.imgMb ?? 210) * 1024 * 1024 + 4e6 },
    heartbeat: heartbeat(o.downAt),
    live_activity: o.live ?? null,
  };
}

function machine(o) {
  return {
    online: true,
    cpu_model: o.model,
    cpu_cores: o.threads,
    cpu_physical_cores: o.cores,
    cpu: o.cpu,
    ram: o.ram,
    ram_total_bytes: o.ramGb * 1024 ** 3,
    temperature: o.temp,
    uptime: o.uptimeDays * 86400,
    load1: o.load,
    network_rx: o.rx,
    network_tx: o.tx,
    filesystems: o.fs,
    disk_io: [{ device: "nvme0n1", name: "nvme0n1", read_bps: 8_000_000, write_bps: 2_500_000 }],
    // The physical NIC carries the rx/tx headline; the tailscale link is
    // real traffic that the headline doesn't count.
    interfaces: o.ifaces ?? [
      { device: "eth0", name: "eth0", rx_bps: o.rx, tx_bps: o.tx, in_total: true },
      {
        device: "tailscale0",
        name: "tailscale0",
        rx_bps: Math.round(o.rx * 0.08),
        tx_bps: Math.round(o.tx * 0.15),
        in_total: false,
      },
    ],
    agent_reachable: true,
    agent_stale_age: null,
    gpu: o.gpu ?? { available: false, count: 0, devices: [] },
    backup: o.backup ?? { state: "not_configured" },
  };
}

function wave(base, jitter, n = 40, failEvery = 0) {
  return Array.from({ length: n }, (_, i) =>
    failEvery && i % failEvery === failEvery - 1
      ? null
      : Math.round((base + Math.sin(i / 3) * jitter + ((i * 7) % 5)) * 10) / 10
  );
}

function demoChecks() {
  const t = now();
  const base = { interval: 60, timeout: 5, expect_status: null, verify_tls: true, keyword: null, keyword_mode: "present", paused: false, failing: 0, down_since: null };
  return [
    { ...base, id: "k1", name: "Jellyfin", type: "http", target: "http://bigboy:8096", status: "up", last_ok: true, latency_ms: 34.2, detail: "HTTP 200", checked_at: t - 22, uptime_24h: 100, uptime_7d: 99.97, uptime_30d: 99.91, avg_ms_24h: 36.1, recent: wave(35, 6) },
    { ...base, id: "k2", name: "Router", type: "tcp", target: "192.168.1.1:443", status: "up", last_ok: true, latency_ms: 2.1, detail: "connected", checked_at: t - 41, uptime_24h: 100, uptime_7d: 100, uptime_30d: 99.99, avg_ms_24h: 2.4, recent: wave(2, 0.6) },
    { ...base, id: "k3", name: "Internet", type: "tcp", target: "1.1.1.1:443", status: "up", last_ok: true, latency_ms: 18.4, detail: "connected", checked_at: t - 9, uptime_24h: 99.79, uptime_7d: 99.6, uptime_30d: 99.7, avg_ms_24h: 21.8, recent: wave(19, 5) },
    { ...base, id: "k4", name: "DNS", type: "dns", target: "example.com", status: "up", last_ok: true, latency_ms: 11.6, detail: "resolved to 93.184.215.14", checked_at: t - 33, uptime_24h: 100, uptime_7d: 99.98, uptime_30d: 99.95, avg_ms_24h: 13.2, recent: wave(12, 4) },
    { ...base, id: "k5", name: "Nextcloud", type: "http", target: "https://cloud.example.com", status: "down", last_ok: false, latency_ms: null, detail: "HTTP 502", checked_at: t - 15, down_since: t - 1080, failing: 18, uptime_24h: 93.4, uptime_7d: 98.7, uptime_30d: 99.2, avg_ms_24h: 210.5, recent: [...wave(200, 30, 22), ...Array(18).fill(null)] },
    { ...base, id: "k6", name: "Grafana", type: "http", target: "http://thinkpad:3000", status: "up", last_ok: true, latency_ms: 88.9, detail: "HTTP 200", checked_at: t - 50, failing: 1, uptime_24h: 99.5, uptime_7d: 99.8, uptime_30d: 99.9, avg_ms_24h: 71.4, recent: wave(75, 20, 40, 13) },
    { ...base, id: "k8", name: "Gateway", type: "ping", target: "192.168.1.1", status: "up", last_ok: true, latency_ms: 0.9, detail: "reply from 192.168.1.1", checked_at: t - 12, uptime_24h: 100, uptime_7d: 100, uptime_30d: 99.99, avg_ms_24h: 1.1, recent: wave(1, 0.3) },
    { ...base, id: "k9", name: "Pi-hole", type: "keyword", target: "http://thinkpad:8080/admin", keyword: "Pi-hole", status: "up", last_ok: true, latency_ms: 46.3, detail: 'HTTP 200 · found "Pi-hole"', checked_at: t - 27, uptime_24h: 100, uptime_7d: 99.9, uptime_30d: 99.8, avg_ms_24h: 47.9, recent: wave(47, 9) },
    { ...base, id: "k7", name: "Plex", type: "http", target: "http://nuc-media:32400/web", status: "paused", paused: true, last_ok: null, latency_ms: null, detail: null, checked_at: null, uptime_24h: null, uptime_7d: null, uptime_30d: null, avg_ms_24h: null, recent: [] },
  ];
}

// Mirrors GET /api/connections/{host}. bigboy is serving media and
// seeding; nuc-media's agent hasn't had its conntrack table mounted, which
// is the state most hosts start in.
export function demoConnections(host) {
  const peers = {
    bigboy: [
      // Inbound to a published port: DNAT'd, so rx/tx are the swap of
      // orig/reply. Someone is streaming 4 GB *out* of this host.
      { proto: "tcp", family: "ipv4", src: "192.168.1.40", dst: "192.168.1.10", dport: 8096, flows: 4, orig_bytes: 51_200, reply_bytes: 4_294_967_296, states: ["ESTABLISHED"], container: "jellyfin", container_id: "bbb222", peer_container: null, direction: "in", peer: "192.168.1.40", peer_port: 8096, rx_bytes: 51_200, tx_bytes: 4_294_967_296 },
      // Outbound from a container: masqueraded, so orig.src is its own IP.
      { proto: "tcp", family: "ipv4", src: "172.18.0.4", dst: "185.125.190.58", dport: 51413, flows: 37, orig_bytes: 2_147_483_648, reply_bytes: 310_000_000, states: ["ESTABLISHED", "TIME_WAIT"], container: "qbittorrent", container_id: "ccc333", peer_container: null, direction: "out", peer: "185.125.190.58", peer_port: 51413, rx_bytes: 310_000_000, tx_bytes: 2_147_483_648 },
      // Both ends on the same bridge.
      { proto: "tcp", family: "ipv4", src: "172.18.0.7", dst: "172.18.0.9", dport: 5432, flows: 3, orig_bytes: 4_000, reply_bytes: 9_000, states: ["ESTABLISHED"], container: "booklore", container_id: "ddd444", peer_container: "booklore-db", direction: "out", peer: "172.18.0.9", peer_port: 5432, rx_bytes: 9_000, tx_bytes: 4_000 },
      // Belongs to no container — named from the host's socket tables.
      { proto: "tcp", family: "ipv4", src: "192.168.1.10", dst: "140.82.121.4", dport: 443, flows: 2, orig_bytes: 9_000, reply_bytes: 120_000, states: ["ESTABLISHED"], container: null, container_id: null, peer_container: null, direction: null, peer: null, peer_port: null, rx_bytes: null, tx_bytes: null, process: "gitea", pid: 812 },
      // Host traffic whose socket had already closed, so nothing to name.
      { proto: "udp", family: "ipv4", src: "192.168.1.10", dst: "1.1.1.1", dport: 53, flows: 12, orig_bytes: 3_400, reply_bytes: 18_900, states: [], container: null, container_id: null, peer_container: null, direction: null, peer: null, peer_port: null, rx_bytes: null, tx_bytes: null, process: null, pid: null },
    ],
    thinkpad: [
      { proto: "tcp", family: "ipv4", src: "172.19.0.2", dst: "140.82.121.4", dport: 443, flows: 6, orig_bytes: 88_000, reply_bytes: 1_200_000, states: ["ESTABLISHED"], container: "homelab-agent", container_id: "eee555", peer_container: null, direction: "out", peer: "140.82.121.4", peer_port: 443, rx_bytes: 1_200_000, tx_bytes: 88_000 },
    ],
  }[host];

  if (!peers) {
    return {
      host,
      available: false,
      state: "not_configured",
      reason:
        "conntrack table is empty here — the agent has its own network " +
        "namespace, so mount the host's table in " +
        "(-v /proc/net/nf_conntrack:/host/nf_conntrack:ro).",
      peers: [],
    };
  }

  return {
    host,
    available: true,
    state: "ok",
    accounting: true,
    attributed: true,
    processes: true,
    source: "/host/proc/1/net/nf_conntrack",
    flows_total: peers.reduce((n, p) => n + p.flows, 0),
    conversations_total: peers.length,
    truncated: false,
    updated_at: now(),
    cached_age: 0,
    peers,
  };
}

// Mirrors GET /api/rebalance. Nothing to move: the demo fleet's hot node
// (nuc-media) has no scheduler-managed stateless workload on it, so a real
// backend would return an empty list here too.
export function demoRebalance() {
  return { suggestions: [], checked_at: now(), auto: false };
}

const RANGE_SHAPE = { "3h": [36, 300], "24h": [24, 3600], "7d": [84, 7200], "30d": [90, 28800] };

// Mirrors GET /api/checks/{id}/history.
export function demoCheckHistory(id, range) {
  const [count, width] = RANGE_SHAPE[range] ?? RANGE_SHAPE["24h"];
  const end = Math.floor(now() / width) * width + width;
  const down = id === "k5";
  const per = Math.max(1, Math.round(width / 60));

  const points = Array.from({ length: count }, (_, i) => {
    const bad = down && i >= count - Math.max(1, Math.round(count * 0.06));
    const partial = down && i === count - Math.max(1, Math.round(count * 0.06)) - 1;
    const n = per;
    const up = bad ? 0 : partial ? Math.round(n / 2) : n;
    const base = id === "k2" ? 2 : id === "k3" ? 19 : 40;
    const ms = up ? Math.round((base + Math.sin(i / 4) * base * 0.3 + (i % 5)) * 10) / 10 : null;
    return { t: end - (count - i) * width, n, up, ms_avg: ms, ms_max: ms ? Math.round(ms * 1.8 * 10) / 10 : null };
  });

  const total = points.reduce((a, p) => a + p.n, 0);
  const ups = points.reduce((a, p) => a + p.up, 0);
  return { range, bucket_seconds: width, uptime: Math.round((10000 * ups) / total) / 100, points };
}

export function demoSnapshot() {
  const machines = {
    bigboy: machine({
      model: "AMD Ryzen 7 5800X 8-Core Processor",
      threads: 16,
      cores: 8,
      cpu: 38,
      ram: 71,
      ramGb: 64,
      temp: 58,
      uptimeDays: 41,
      load: 2.4,
      rx: 4_800_000,
      tx: 1_200_000,
      backup: { state: "ok", running: false, interval_hours: 12, last_success_age: 3 * 3600, last_run_age: 3 * 3600, last_error: null, projects: 4 },
      fs: [
        { device: "/dev/nvme0n1p2", mountpoint: "/", used_percent: 46, used_bytes: 460e9, total_bytes: 1000e9, free_bytes: 540e9 },
        { device: "/dev/sda1", mountpoint: "/mnt/media", used_percent: 88, used_bytes: 15.8e12, total_bytes: 18e12, free_bytes: 2.2e12, days_until_full: 6.5 },
      ],
      gpu: {
        available: true,
        count: 1,
        devices: [
          {
            vendor: "nvidia",
            name: "NVIDIA GeForce GTX 1650 SUPER",
            utilization_percent: 34,
            memory_used_mb: 1820,
            memory_total_mb: 4096,
            temperature_c: 61,
            power_draw_w: 58,
            power_limit_w: 100,
            fan_percent: 42,
          },
        ],
      },
    }),
    thinkpad: machine({
      model: "Intel Core i7-8550U",
      threads: 8,
      cores: 4,
      cpu: 9,
      ram: 34,
      ramGb: 16,
      temp: 47,
      uptimeDays: 12,
      load: 0.3,
      rx: 220_000,
      tx: 90_000,
      backup: { state: "ok", running: false, interval_hours: 12, last_success_age: 40 * 60, last_run_age: 40 * 60, last_error: null, projects: 2 },
      fs: [{ device: "/dev/sda2", mountpoint: "/", used_percent: 52, used_bytes: 250e9, total_bytes: 480e9, free_bytes: 230e9 }],
    }),
    "nuc-media": machine({
      model: "Intel N100",
      threads: 4,
      cores: 4,
      cpu: 71,
      ram: 91,
      ramGb: 16,
      temp: 74,
      uptimeDays: 3,
      load: 3.1,
      rx: 12_000_000,
      tx: 900_000,
      backup: { state: "failing", running: false, interval_hours: 12, last_success_age: 30 * 3600, last_run_age: 120, last_error: "push rejected after retries: authentication failed", projects: 3 },
      fs: [{ device: "/dev/nvme0n1p1", mountpoint: "/", used_percent: 91, used_bytes: 218e9, total_bytes: 240e9, free_bytes: 22e9 }],
    }),
  };

  const containers = {
    bigboy: [
      container("a1", "jellyfin", "jellyfin/jellyfin:latest", "bigboy", {
        cpu: 22.5, ramMb: 1400, limitMb: 4096, ports: { "8096/tcp": ["8096"] },
        rx: 3_200_000, tx: 18_000_000, live: { app: "jellyfin", detail: "2 users streaming" },
      }),
      container("a2", "qbittorrent", "lscr.io/linuxserver/qbittorrent:latest", "bigboy", {
        cpu: 6.8, ramMb: 610, ports: { "8080/tcp": ["8080"] },
        rx: 9_500_000, tx: 1_100_000, live: { app: "qbittorrent", detail: "3 downloading, 5 seeding" },
      }),
      container("a3", "sonarr", "lscr.io/linuxserver/sonarr:latest", "bigboy", { cpu: 0.8, ramMb: 380, ports: { "8989/tcp": ["8989"] } }),
      container("a4", "radarr", "lscr.io/linuxserver/radarr:latest", "bigboy", { cpu: 0.6, ramMb: 340, ports: { "7878/tcp": ["7878"] } }),
      container("a5", "postgres", "postgres:16", "bigboy", { cpu: 1.4, ramMb: 220, limitMb: 1024, health: "healthy" }),
      container("a6", "homelab-agent", "homelab-agent", "bigboy", { cpu: 0.4, ramMb: 60 }),
      container("a7", "watchtower", "containrrr/watchtower", "bigboy", { status: "exited", cpu: 0, ramMb: 0, upHours: 200 }),
    ],
    thinkpad: [
      container("b1", "homelab-dashboard", "homelab-dashboard", "thinkpad", { cpu: 0.9, ramMb: 90, ports: { "80/tcp": ["8081"] } }),
      container("b2", "prometheus", "prom/prometheus:latest", "thinkpad", { cpu: 2.1, ramMb: 480, ports: { "9090/tcp": ["9090"] } }),
      container("b3", "grafana", "grafana/grafana:latest", "thinkpad", { cpu: 1.1, ramMb: 210, ports: { "3000/tcp": ["3000"] }, health: "healthy" }),
      container("b4", "homelab-agent", "homelab-agent", "thinkpad", { cpu: 0.3, ramMb: 55 }),
    ],
    "nuc-media": [
      container("c1", "plex", "plexinc/pms-docker:latest", "nuc-media", { cpu: 48.0, ramMb: 2100, ports: { "32400/tcp": ["32400"] } }),
      container("c2", "nextcloud", "nextcloud:29", "nuc-media", {
        cpu: 3.2, ramMb: 900, health: "unhealthy", restarts: 7, downAt: [96, 97, 98, 99, 100, 101], ports: { "80/tcp": ["8082"] },
      }),
      container("c3", "homelab-agent", "homelab-agent", "nuc-media", { cpu: 0.4, ramMb: 58 }),
    ],
  };

  const history = {};
  for (const [name, m] of Object.entries(machines)) {
    history[name] = {
      cpu: series(m.cpu, 8),
      ram: series(m.ram, 4),
      temperature: series(m.temperature, 3),
      network_rx: series(m.network_rx, m.network_rx * 0.4),
      network_tx: series(m.network_tx, m.network_tx * 0.4),
      gpu_temperature: m.gpu?.devices?.length ? series(60, 4) : [],
    };
  }

  const t = now();
  return {
    machines,
    containers,
    history,
    checks: demoChecks(),
    deployments: [
      {
        id: "d1", kind: "container", status: "running", placed_on: "bigboy", score: 82,
        created_at: t - 86400 * 2,
        spec: { image: "traefik/whoami:latest", name: "whoami", ports: [{ container: 80, host: 8090, proto: "tcp" }], resources: { cpus: 0.25, memory_mb: 64 } },
        events: [
          { kind: "created", at: t - 86400 * 2, detail: "created" },
          { kind: "deployed", at: t - 86400 * 2 + 20, detail: "deployed to bigboy" },
        ],
      },
    ],
    activity: [
      { at: t - 300, kind: "container_unhealthy", text: "nextcloud on nuc-media became unhealthy" },
      { at: t - 1900, kind: "container_restart", text: "nextcloud on nuc-media restarted" },
      { at: t - 7200, kind: "container_start", text: "plex on nuc-media started" },
      { at: t - 86400, kind: "deploy", text: "whoami deployed to bigboy" },
    ],
    // Alert episodes: the open ones match the overview issues below, plus
    // a couple that already resolved.
    alerts: [
      { key: "container:nuc-media:nextcloud:unhealthy", at: t - 300, resolved_at: null, severity: "bad", host: "nuc-media", title: "nextcloud is unhealthy", message: "nextcloud on nuc-media is failing its healthcheck" },
      { key: "check:k5", at: t - 1080, resolved_at: null, severity: "bad", host: null, title: "Nextcloud is down", message: "Nextcloud (http https://cloud.example.com) has been failing for 18 min — HTTP 502" },
      { key: "host:nuc-media:ram", at: t - 5400, resolved_at: null, severity: "warn", host: "nuc-media", title: "nuc-media RAM high", message: "nuc-media RAM at 91% (threshold 90%)" },
      { key: "host:bigboy:temp", at: t - 39600, resolved_at: t - 36000, severity: "warn", host: "bigboy", title: "bigboy running hot", message: "bigboy CPU at 87°C (threshold 85°C)" },
      { key: "host:nuc-media:offline", at: t - 90000, resolved_at: t - 88800, severity: "bad", host: "nuc-media", title: "nuc-media offline", message: "nuc-media stopped responding to Prometheus" },
    ],
    mainHost: "thinkpad",
    // Mirrors what backend/alerts.py + main._overview would produce for the
    // fleet above (worst first, same keys and wording).
    overview: {
      ok: false,
      issues: [
        { key: "container:nuc-media:nextcloud:unhealthy", severity: "bad", title: "nextcloud is unhealthy", message: "nextcloud on nuc-media is failing its healthcheck" },
        { key: "check:k5", severity: "bad", title: "Nextcloud is down", message: "Nextcloud (http https://cloud.example.com) has been failing for 18 min — HTTP 502" },
        { key: "host:nuc-media:backup", severity: "bad", title: "nuc-media backup failing", message: "The last backup on nuc-media failed: push rejected after retries: authentication failed" },
        { key: "host:bigboy:diskfull:/mnt/media", severity: "warn", title: "bigboy /mnt/media filling up", message: "/mnt/media on bigboy will be full in about 7 days at its current rate" },
        { key: "host:nuc-media:disk:/", severity: "warn", title: "nuc-media / is 91% full", message: "/ on nuc-media is 91% full, 22 GB free" },
        { key: "host:nuc-media:ram", severity: "warn", title: "nuc-media RAM high", message: "nuc-media RAM at 91% (threshold 90%)" },
      ],
      recommendations: [
        "Check that https://cloud.example.com is up and reachable from the dashboard host — a check runs from the dashboard container, so 'localhost' is the dashboard itself.",
        "Read nextcloud's logs on nuc-media (docker logs nextcloud) — its healthcheck is failing.",
        "Check homelab-agent's logs on nuc-media and its BACKUP_REPO / GITHUB_TOKEN settings.",
        "bigboy is filling up — find what's growing (docker system df, du -sh) before it hits 100%.",
        "Free space on nuc-media — clear old logs and images (docker system prune) or extend the volume.",
        "Free memory on nuc-media or move a workload off it.",
      ],
    },
    pins: ["bigboy/jellyfin", "bigboy/qbittorrent", "nuc-media/plex"],
    todos: [
      { id: "t1", text: "Replace failing disk in bigboy", done: false, created_at: t },
      { id: "t2", text: "Renew wildcard cert", done: false, created_at: t },
      { id: "t3", text: "Set up offsite backups", done: true, created_at: t },
    ],
  };
}

// Personal tab fixtures (weather / word of the day) so /?demo needs no backend.
export const demoPersonal = {
  weather: (units) => {
    const f = units === "imperial";
    const t = (c) => (f ? Math.round((c * 9) / 5 + 32) : c);
    const day = (i) => new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10);
    return {
      units: { temp: f ? "°F" : "°C", wind: f ? "mph" : "km/h" },
      timezone: "America/Toronto",
      current: { temperature: t(17), feels_like: t(15), humidity: 63, wind: f ? 9 : 15, code: 2, is_day: true },
      daily: [
        { date: day(0), code: 2, high: t(19), low: t(9), precip: 8 },
        { date: day(1), code: 3, high: t(21), low: t(11), precip: 20 },
        { date: day(2), code: 61, high: t(17), low: t(10), precip: 70 },
        { date: day(3), code: 80, high: t(16), low: t(8), precip: 55 },
        { date: day(4), code: 0, high: t(20), low: t(7), precip: 0 },
      ],
    };
  },
  places: (q) => [
    { name: q.charAt(0).toUpperCase() + q.slice(1), region: "Ontario", country: "Canada", latitude: 43.46, longitude: -80.52 },
    { name: q.charAt(0).toUpperCase() + q.slice(1), region: "Iowa", country: "United States", latitude: 42.49, longitude: -92.34 },
  ],
  word: {
    word: "supernova",
    part_of_speech: "n",
    definitions: [
      "(astronomy) A bright and powerful explosion of a massive star which is sudden but brief.",
      "(figurative) Something which is brilliant or explosive.",
    ],
    url: "https://en.wiktionary.org/wiki/supernova#English",
    date: new Date().toISOString().slice(0, 10),
  },
};

// Personal-tab notes for /?demo (kept in memory by notesApi).
export function demoNotesSeed() {
  const t = now();
  return [
    { id: "n1", created_at: t - 86400 * 3, updated_at: t - 1800, body: "Router maintenance window\n\nFirmware update Saturday 2am. Reserve a DHCP lease for the NAS first.\nPort forward 51820/udp for WireGuard." },
    { id: "n2", created_at: t - 86400 * 9, updated_at: t - 86400 * 2, body: "Backup plan\n\n- offsite: rsync to the friend's Pi weekly\n- test a restore once a quarter\n- rotate the GitHub token in March" },
    { id: "n3", created_at: t - 86400 * 20, updated_at: t - 86400 * 6, body: "Shopping list\n2x 4TB drives, SATA cables, a UPS for the rack" },
  ];
}
