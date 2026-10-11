# GPU, disk health and long-range history

## GPUs: NVIDIA, AMD, Intel

The agent finds every GPU from `/sys/class/drm` (mounted into every container, so AMD and
Intel need no setup) and asks `nvidia-smi` for NVIDIA cards (needs `AGENT_RUNTIME=nvidia`).
Names come from the host's own `pci.ids`. What a card can say depends on its driver, and the
dashboard shows exactly that and nothing guessed:

| Driver | Reported |
|---|---|
| NVIDIA (`nvidia-smi`) | load, VRAM, clocks, temperature, power and limit, fan |
| AMD (`amdgpu`) | load, VRAM, core and memory clock, temperature (edge, junction, memory), power and cap, fan |
| Intel (`i915`, `xe`) | clocks, and **active** (the share of time the GPU was out of its idle state). This is activity, not engine load, and is labelled that way. Arc cards add VRAM, power, temperature and fan. |
| Anything else | hwmon temperature and fan, if the driver has them |

A card its driver says nothing about (the ThinkPad's 2010 Intel iGPU is one) is listed by
name with a note, not shown as a quiet GPU. An NVIDIA card the container can't query still
gets the runtime hint. The edge temperature, not the hotter junction, is the one alerts use.

## Disk health (SMART)

Every 30 minutes (`SMART_INTERVAL_MINUTES` on the agent, 0 = off) the agent starts a short-lived
privileged helper from its own image, which runs `smartctl` and exits. Nothing is installed on
the host. A drive that is spun down is never woken: it keeps its last reading, marked *asleep*.

| Verdict | When |
|---|---|
| **bad** | the drive reports it is failing; pending or uncorrectable sectors; an NVMe critical warning, spent spare capacity or media errors; rated wear used up |
| **warn** | reallocated sectors, CRC (cable) errors, wear over 90%, running at 65 °C or more |
| ok / unknown | none of that / no SMART data (USB bridges and virtual disks often have none) |

Shown under System → Disks (and in each server card). A bad or warn drive raises an alert.
The agent must be rebuilt once to get `smartctl`.

## History

System → History shows one host over 6 h, 24 h, 7 d, 30 d or 90 d: CPU, memory, CPU
temperature (peak), load, network, disk fill, and the GPU. Each point averages its step (30
minutes at 7 d, 2 hours at 30 d), so a short spike disappears on a long range: the step is
shown beside the range picker.

- **Host graphs** come from Prometheus. Retention on the thinkpad was raised from 15 to 90 days
  (`--storage.tsdb.retention.time=90d`, about 60 MB a day), so 30 d and 90 d fill up over time.
- **GPU graphs** come from the dashboard's own store, because nothing scrapes a GPU: 15-minute
  buckets for `GPU_HISTORY_DAYS` (default 90) in `/data/gpu-history.json`, about 1 MB per card.
- Network → Bandwidth has its own range (2 h, 24 h, 7 d, 30 d) over the switch ports.
