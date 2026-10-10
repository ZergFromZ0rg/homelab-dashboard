# Switch monitoring

Network → Switch shows each port of the managed switch: link up/down, negotiated
speed, traffic both ways and errors. The same data raises alerts and tells the
Pi-hole device table which port a device is plugged into.

```
dashboard ──asks──▶ Prometheus ──every 30 s──▶ snmp_exporter (bigboy) ──SNMP──▶ switch
```

Only Prometheus keeps history; the switch knows "right now". The dashboard never
talks to the switch or the exporter, and the browser never talks to Prometheus.

## Setup (as deployed)

The switch (Netgear GS110TP, `192.168.0.109`) answers SNMP v2c with a read-only
community that it accepts only from bigboy (`192.168.0.246`), so the exporter
runs there.

**bigboy**: `~/snmp-exporter/`

- `compose.yaml`: one container, `prom/snmp-exporter` pinned to the version that
  `snmp.yml` was generated from (v0.30.1), port 9116.
- `snmp.yml`: the image's default config with one extra entry under `auths:`
  named `overlord` (the community and `version: 2`). `snmp.yml.orig` is the
  untouched copy. Only `auths:` is edited; the rest is thousands of generated lines.
- Test: `curl -s 'http://localhost:9116/snmp?target=192.168.0.109&module=if_mib&auth=overlord' | grep ifHCInOctets`

**thinkpad**: `/home/zerg/docker/stacks/prometheus/prometheus.yml` has a job named
`switch` (30 s interval, 20 s timeout, `module=if_mib`, `auth=overlord`, target
rewritten to `192.168.0.246:9116`). The backup from before is
`prometheus.yml.bak-before-switch`.

The file is a single-file bind mount: edit it **in place** (`>>`, or an editor that
rewrites the same inode) and reload with `docker kill -s HUP prometheus`. Anything that
replaces the file (`mv`, `sed -i`, an editor's safe-save) leaves the container
reading the old one.

## What counts as a port you care about

A port with a **description on the switch** (Switching → Ports → Description). The
alerts watch those only. An undescribed port is listed while something is plugged
into it, tagged `no label`, so a new device is noticed. To stop watching a port,
clear its description.

A port named like a device finds that device in the Pi-hole table, ignoring case:
the port `Bigboy` matches the device `bigboy`.

## Alerts

All appear in Attention and go to the alert webhook like the rest. "Usual" speed is
what the port has run at in the last 7 days, so the router at a steady 100 Mbps is
not an alert but a gigabit port falling back to 100 is.

| Alert | Fires when |
|---|---|
| Switch is not answering SNMP | every scrape failed for 2 min |
| `<port>` link is down | a described port had no link for 2 min and was up some time this week |
| `<port>` link dropped | speed is below the port's 7-day maximum (clears itself after a week if intended) |
| `<port>` port is logging errors | more than `SWITCH_ERRORS_PER_15M` bad packets in 15 min |
| `<uplink>` link is nearly full | averaged over `SWITCH_UPLINK_PERCENT` of its speed for 10 min |

The last four are silent while the switch is unreachable (its own alert says so),
and nothing about the switch is raised while Prometheus itself can't be asked.

## Settings

All optional, in the dashboard's `.env`:

| Variable | Default | |
|---|---|---|
| `SWITCH_JOB` | `switch` | the Prometheus `job_name` |
| `SWITCH_UPLINK_PORT` | `router` | description of the internet-facing port |
| `SWITCH_ERRORS_PER_15M` | `50` | |
| `SWITCH_UPLINK_PERCENT` | `90` | |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Switch section says Prometheus has no job named `switch` | the scrape job isn't loaded: Prometheus → Status → Targets |
| Target DOWN, "context deadline exceeded" | the walk is slower than `scrape_timeout`; raise it (keep interval ≥ timeout) |
| Target DOWN, "connection refused" | wrong exporter address in `replacement` |
| Exporter log: unknown auth | the `overlord` entry in `snmp.yml` is missing or mis-indented |
| `snmpget` times out | the switch ignores community names containing `-`, or the request isn't from bigboy |

Traffic is shown from the **device's** side: "To device" is what the switch sends
down the port, "From device" what the device sends it. (The switch's own "in"
counter is the second one.)
