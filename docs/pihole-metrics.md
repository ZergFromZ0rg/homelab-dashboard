# Pi-hole metrics and agent tools

Two read-only ways to use the Pi-hole data the dashboard already collects.
Neither talks to Pi-hole, and neither can change anything.

## Prometheus metrics

`GET /api/pihole/metrics` serves the same numbers the Network → DNS tab shows,
in Prometheus text format. Grafana then needs no separate Pi-hole exporter.

| Metric | Meaning |
|---|---|
| `pihole_up` | 1 if the dashboard reached Pi-hole on its last poll |
| `pihole_last_poll_timestamp_seconds` | when Pi-hole last answered |
| `pihole_blocking_enabled` | 1 on, 0 paused |
| `pihole_queries_24h`, `pihole_blocked_24h` | queries and blocked queries over the last 24 hours |
| `pihole_block_ratio` | blocked ÷ queries, 0 to 1 |
| `pihole_gravity_domains` | domains on the blocklists |
| `pihole_dhcp_leases` | active DHCP leases |
| `pihole_clients_known`, `pihole_clients_online` | devices seen, and devices online now |
| `pihole_new_devices` | newcomers nobody has named or marked known |
| `pihole_device_queries_24h`, `pihole_device_blocked_24h`, `pihole_device_online` | per device, labelled `name`, `mac`, `kind` |

All are gauges. Pi-hole's counts are over a **sliding 24 hours**, not a
number that only grows, which is why they end in `_24h` and not `_total`:
`rate()` on them would be wrong. To see change over time, graph the gauge.

Devices carry the **name you gave them in the dashboard**, so Grafana and the
dashboard agree. The MAC is in every label too; it survives a rename. IPs are
left out on purpose, since a DHCP lease moving would start a new series each
time. A device that doesn't use Pi-hole for DNS (the switch) has no
`pihole_device_online`, rather than a false 0.

If Pi-hole can't be reached, the last numbers are still served with
`pihole_up 0`, so a graph shows the gap's cause instead of a hole.

### Letting Prometheus in

The dashboard needs sign-in, which Prometheus can't do. Give it a token that
opens this one route and nothing else:

```bash
openssl rand -hex 24                    # make one
echo 'METRICS_TOKEN=<that value>' >> ~/homelab-dashboard/.env
docker compose up -d                    # in ~/homelab-dashboard
```

Without `METRICS_TOKEN` the endpoint stays behind sign-in. The token is not
`API_TOKEN`: it can't pause blocking, allow a domain or touch any other route
(the tests check that).

Add a job to `prometheus.yml`. The dashboard joins Prometheus's Docker
network, so it is reachable by container name:

```yaml
  - job_name: "pihole"
    scrape_interval: 30s
    metrics_path: /api/pihole/metrics
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["homelab-dashboard-api:8000"]
```

Pi-hole data refreshes every 60 s, so scraping faster tells you nothing new.
Reload with `docker kill -s HUP prometheus`.

### Grafana

Import [`grafana/pihole.json`](grafana/pihole.json) (Dashboards → New →
Import) and pick your Prometheus. It shows Pi-hole up/paused, the blocked
share, devices online, the busiest and most-blocked devices, and how long ago
Pi-hole last answered.

## Tools for an agent

`GET /api/agent/tools` lists four read-only tools in the shape tool-calling
APIs take (`name`, `description`, `input_schema`); `GET /api/agent/tools/{name}`
runs one, with arguments as query parameters. They need the same sign-in as
the rest of the API.

| Tool | Answers |
|---|---|
| `network_summary` | Is Pi-hole up, is blocking on, queries and blocked share in 24 h, devices known/online/new, open alerts |
| `network_devices` | Every device with name, kind, IP, online, vendor, queries and blocked share, first/last seen, switch port. Filter `?online=true` or `?kind=server` |
| `network_device?device=firestick` | One device by name or MAC, with its latest 50 queries and the domains blocked most. Says so if the name matches several |
| `network_alerts` | Pi-hole unreachable, unnamed new device, blocking far above usual, and the switch's alerts |

The agent sees exactly what the dashboard shows. It can't pause blocking, allow
a domain or move a device to a group: those stay buttons you click.
