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
    agent_reachable: true,
    agent_stale_age: null,
    gpu: o.gpu ?? { available: false, count: 0, devices: [] },
  };
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
      fs: [
        { device: "/dev/nvme0n1p2", mountpoint: "/", used_percent: 46, used_bytes: 460e9, total_bytes: 1000e9, free_bytes: 540e9 },
        { device: "/dev/sda1", mountpoint: "/mnt/media", used_percent: 88, used_bytes: 15.8e12, total_bytes: 18e12, free_bytes: 2.2e12 },
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
      fs: [{ device: "/dev/sda2", mountpoint: "/", used_percent: 52, used_bytes: 250e9, total_bytes: 480e9, free_bytes: 230e9 }],
    }),
    "nuc-media": machine({
      model: "Intel N100",
      threads: 4,
      cores: 4,
      cpu: 71,
      ram: 88,
      ramGb: 16,
      temp: 74,
      uptimeDays: 3,
      load: 3.1,
      rx: 12_000_000,
      tx: 900_000,
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
    mainHost: "thinkpad",
    overview: {
      ok: false,
      issues: [
        { key: "container:nuc-media:nextcloud", severity: "bad", title: "nextcloud is unhealthy", message: "On nuc-media, restarted 7 times." },
        { key: "host:nuc-media:ram", severity: "warn", title: "nuc-media RAM at 88%", message: "Consider moving a container off this host." },
        { key: "disk:bigboy:/mnt/media", severity: "warn", title: "bigboy /mnt/media is 88% full", message: "2.2 TB free." },
      ],
      recommendations: [],
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
