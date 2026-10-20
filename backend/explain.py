"""Why is this container busy? The evidence, and what it adds up to.

No model in here, on purpose. Everything below is arithmetic over data the
dashboard already keeps: the container's live stats, its own week of CPU and
memory, the activity feed, the host it shares, the backups that are running.
The result is a short verdict plus findings that each say what they were
measured from, so a claim is always something you can check against the
History charts rather than a guess.

It is also the evidence a language model would be given later: a model that
only has to narrate a dozen checked facts can run on a small local model and
cannot invent a cause the numbers don't show.

``explain`` is pure — everything it needs is passed in — so it is tested with
made-up series. ``explain_api`` does the gathering.
"""

from __future__ import annotations

import math
import time
from datetime import datetime

MINUTE = 60
HOUR = 3600
MEBI = 1024**2

# Below this a container hasn't had a week of its own to compare against;
# "high" would be a guess, so the verdict says so instead.
MIN_BASELINE_SECONDS = 3 * HOUR
MIN_BASELINE_POINTS = 24
# The baseline is the container's life *before* the last two hours, so a
# problem that has just begun can't redefine what normal is.
RECENT_SECONDS = 2 * HOUR

# CPU is Docker's: 100 = one logical CPU. Under these a ratio is noise —
# "10x usual" of 0.3% is still nothing.
CPU_FLOOR = 15.0
CPU_BUSY_FLOOR = 10.0
# Past this a multiple stops meaning anything ("66× usual").
FAR_ABOVE = 50
RAM_FLOOR = 100 * MEBI

# A shape needs enough points that one odd sample can't make it.
MIN_SHAPE_POINTS = 12
MIN_SEGMENT = 4
STEP_FIT = 0.8
LINE_FIT = 0.85

BUSY_RUN_MIN_SECONDS = 15 * MINUTE
YOUNG_SECONDS = 15 * MINUTE
IO_NOTABLE_BPS = 5 * MEBI
HOST_LOADED_PERCENT = 90

# Host events that change what a container does without anyone touching it.
HOST_EVENT_KINDS = {"node_rebooted", "os_updated", "agent_up", "agent_down", "node_up"}
CONTAINER_EVENT_KINDS = {
    "container_restart", "container_recreated", "container_new", "container_start",
    "container_stop", "container_unhealthy", "container_healthy", "deploy", "move",
}

_UNITS = ["B", "KB", "MB", "GB", "TB"]


def format_bytes(value: float | None) -> str:
    """Same rounding as the dashboard's formatBytes, so a number in a
    sentence matches the one in the row."""
    if value is None:
        return "—"
    unit = 0
    while value >= 1024 and unit < len(_UNITS) - 1:
        value /= 1024
        unit += 1
    return f"{value:.{1 if unit >= 3 else 0}f} {_UNITS[unit]}"


def format_span(seconds: float) -> str:
    """'45m', '3h 20m', '2d 4h' — a length of time, not a clock time (the
    server's timezone isn't the viewer's, so the page formats instants)."""
    seconds = max(0, int(seconds))
    if seconds < HOUR:
        return f"{max(1, seconds // MINUTE)}m"
    if seconds < 2 * 86400:
        hours, minutes = divmod(seconds // MINUTE, 60)
        return f"{hours}h {minutes}m" if minutes and hours < 10 else f"{hours}h"
    days, rest = divmod(seconds, 86400)
    return f"{days}d {rest // HOUR}h" if rest // HOUR else f"{days}d"


def _cpu_text(percent: float) -> str:
    # Halves round up, as the page's Math.round does — format(22.5, ".0f")
    # gives 22, and the same number would read two ways on one screen.
    text = f"{math.floor(percent + 0.5)}%" if percent >= 10 else f"{percent:.1f}%"
    return f"{text} ({percent / 100:.1f} vCPU)" if percent >= 100 else text


def _percentile(sorted_values: list[float], fraction: float) -> float:
    index = min(len(sorted_values) - 1, max(0, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[index]


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _started_at(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str) or not value or value.startswith("0001-"):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --- what's normal for this container ---------------------------------------


def baseline(points: list[dict], key: str, now: float) -> dict | None:
    """The container's usual level: the median and the top of its normal
    range, taken from before the last two hours. None when there isn't
    enough of its past to call anything unusual."""
    old = [p for p in points if p.get(key) is not None and p["t"] < now - RECENT_SECONDS]
    if len(old) < MIN_BASELINE_POINTS:
        return None
    span = old[-1]["t"] - old[0]["t"]
    if span < MIN_BASELINE_SECONDS:
        return None

    values = sorted(p[key] for p in old)
    return {
        "median": _median(values),
        "p90": _percentile(values, 0.90),
        "p95": _percentile(values, 0.95),
        "hours": round(span / HOUR, 1),
    }


def busy_run(points: list[dict], key: str, cut: float, now: float) -> dict | None:
    """How long it has been above ``cut``, counting back from the newest
    point. One dip back under is forgiven (a busy job pauses between files),
    two in a row end the run. None when it isn't busy now."""
    run_start = None
    misses = 0
    count = 0

    for point in reversed(points):
        value = point.get(key)
        if value is not None and value >= cut:
            run_start = point["t"]
            count += 1
            misses = 0
        else:
            misses += 1
            if misses >= 2:
                break

    if run_start is None or count == 0:
        return None
    seconds = now - run_start
    return {"since": run_start, "seconds": seconds} if seconds >= BUSY_RUN_MIN_SECONDS else None


def _fit_line(times: list[float], values: list[float]) -> tuple[float, float]:
    """Least-squares slope (per second) and how well a straight line
    explains the series (r², 0–1)."""
    n = len(times)
    mean_t = sum(times) / n
    mean_v = sum(values) / n
    sxx = sum((t - mean_t) ** 2 for t in times)
    syy = sum((v - mean_v) ** 2 for v in values)
    if sxx == 0 or syy == 0:
        return 0.0, 0.0
    sxy = sum((t - mean_t) * (v - mean_v) for t, v in zip(times, values))
    return sxy / sxx, (sxy * sxy) / (sxx * syy)


def _best_step(values: list[float]) -> tuple[int, float, float, float] | None:
    """The single split that best explains the series as 'one level, then
    another': (index, mean before, mean after, share of variance it explains)."""
    n = len(values)
    total = sum(values)
    total_sq = sum(v * v for v in values)
    whole = total_sq - total * total / n
    if whole <= 0:
        return None

    best = None
    left = left_sq = 0.0
    for k in range(1, n):
        left += values[k - 1]
        left_sq += values[k - 1] ** 2
        if k < MIN_SEGMENT or n - k < MIN_SEGMENT:
            continue
        right, right_sq = total - left, total_sq - left_sq
        sse = (left_sq - left * left / k) + (right_sq - right * right / (n - k))
        if best is None or sse < best[0]:
            best = (sse, k, left / k, right / (n - k))

    if best is None:
        return None
    sse, k, before, after = best
    return k, before, after, 1 - sse / whole


def memory_shape(points: list[dict]) -> dict:
    """What memory has been doing over the window: steady, climbing,
    falling, stepped (one jump to a new level) or just variable."""
    series = [(p["t"], p["mem"]) for p in points if p.get("mem") is not None]
    if len(series) < MIN_SHAPE_POINTS:
        return {"shape": "unknown"}

    times = [t for t, _ in series]
    values = [v for _, v in series]
    slope, line_fit = _fit_line(times, values)
    step = _best_step(values)
    first_level = _median(values[: max(MIN_SEGMENT, len(values) // 3)])
    last_level = _median(values[-max(MIN_SEGMENT, len(values) // 3):])

    if step:
        index, before, after, step_fit = step
        size = after - before
        if step_fit >= STEP_FIT and step_fit > line_fit and abs(size) >= max(0.2 * min(before, after), RAM_FLOOR):
            return {"shape": "stepped", "change_bytes": size, "at": times[index], "before": before, "after": after}

    window = times[-1] - times[0]
    change = slope * window
    if line_fit >= LINE_FIT and abs(change) >= max(0.15 * first_level, RAM_FLOOR):
        return {
            "shape": "climbing" if slope > 0 else "falling",
            "change_bytes": change,
            "per_hour": slope * HOUR,
            "window_seconds": window,
        }

    ordered = sorted(values)
    spread = _percentile(ordered, 0.95) - _percentile(ordered, 0.05)
    if first_level > 0 and spread / first_level >= 0.3 and spread >= RAM_FLOOR:
        return {"shape": "variable", "low": _percentile(ordered, 0.05), "high": _percentile(ordered, 0.95)}

    return {"shape": "steady", "level": last_level}


# --- putting it together -----------------------------------------------------


def _near(events: list[dict], at: float, before: float = 20 * MINUTE, after: float = 10 * MINUTE):
    return [e for e in events if at - before <= e["at"] <= at + after]


def _relevant_events(events: list[dict], host: str, name: str, now: float) -> list[dict]:
    """The activity entries about this container, plus the host-wide ones
    (a reboot, OS updates) that would change how it behaves."""
    since = now - 24 * HOUR
    out = []
    for e in events:
        if e["at"] < since:
            continue
        kind = e.get("kind")
        about_it = name in (e.get("text") or "") and kind in CONTAINER_EVENT_KINDS
        about_host = e.get("host") == host and kind in HOST_EVENT_KINDS
        if about_it or about_host:
            out.append({"at": e["at"], "kind": kind, "text": e["text"]})
    out.sort(key=lambda e: e["at"], reverse=True)
    return out


def _neighbours(peers: list[dict], name: str) -> list[dict]:
    rows = []
    for c in peers:
        if c.get("name") == name or c.get("status") != "running":
            continue
        stats = c.get("stats") or {}
        cpu = stats.get("cpu_percent")
        mem = (stats.get("memory") or {}).get("used_bytes")
        if (cpu or 0) >= 10 or (mem or 0) >= 1024 * MEBI:
            rows.append({"name": c.get("name"), "cpu": cpu, "mem": mem})
    rows.sort(key=lambda r: (r["cpu"] or 0), reverse=True)
    return rows[:4]


def explain(
    *,
    host: str,
    container: dict,
    machine: dict | None,
    peers: list[dict],
    series_24h: list[dict],
    series_7d: list[dict],
    events: list[dict],
    backup_jobs: list[dict],
    now: float | None = None,
) -> dict:
    now = time.time() if now is None else now
    name = container.get("name") or container.get("id", "?")[:12]
    machine = machine or {}
    stats = container.get("stats") or {}
    memory = stats.get("memory") or {}
    network = stats.get("network") or {}
    block_io = stats.get("block_io") or {}

    findings: list[dict] = []
    suggestions: dict[str, str] = {}

    def add(level, key, title, detail="", at=None):
        findings.append({"level": level, "key": key, "title": title, "detail": detail, "at": at})

    if container.get("status") != "running":
        add("info", "stopped", "It isn't running", f"Status is {container.get('status') or 'unknown'}, so it uses no CPU or memory.")
        return _result(host, name, now, "It isn't running, so it uses no CPU or memory.", findings, {}, {})

    cpu = stats.get("cpu_percent")
    used = memory.get("used_bytes")
    limit = memory.get("limit_bytes") or 0
    cores = machine.get("cpu_cores")
    ram_total = machine.get("ram_total_bytes")
    started = _started_at(container.get("started_at"))
    uptime = now - started if started else None

    # Two windows: the week for "what's normal", the last day, at full
    # resolution, for the shape of what's happening now.
    history_hours = round((series_7d[-1]["t"] - series_7d[0]["t"]) / HOUR, 1) if len(series_7d) > 1 else 0.0
    cpu_base = baseline(series_7d, "cpu", now)
    mem_base = baseline(series_7d, "mem", now)
    shape = memory_shape(series_24h)

    events_here = _relevant_events(events, host, name, now)
    onsets: list[tuple[float, str]] = []

    # --- CPU ---
    cpu_part = "No CPU reading yet"
    cpu_info: dict = {"now": cpu}
    if cpu is not None:
        cpu_part = f"CPU {_cpu_text(cpu)}"
        share = (cpu / (cores * 100)) if cores else None
        cpu_info.update(vcpu=round(cpu / 100, 2), share_of_host=share)
        host_bit = f" — {share * 100:.0f}% of {host}'s {cores} vCPU" if share is not None else ""

        if cpu_base:
            usual = cpu_base["median"]
            high_cut = max(cpu_base["p90"] * 1.25, usual * 2, CPU_FLOOR)
            busy_cut = max(cpu_base["p90"], usual * 1.5, CPU_BUSY_FLOOR)
            run = busy_run(series_24h, "cpu", busy_cut, now)
            times = cpu / usual if usual >= 1 else None
            cpu_info.update(usual=usual, high_end=cpu_base["p90"], threshold=high_cut,
                            times_usual=times, run=run, level="high" if cpu >= high_cut else "normal")

            if cpu >= high_cut:
                if times and 2 <= times < FAR_ABOVE:
                    how = f"about {times:.0f}× its usual {_cpu_text(usual)}"
                elif times and times >= FAR_ABOVE:
                    how = f"far above its usual {_cpu_text(usual)}"
                else:
                    how = f"well above its usual {_cpu_text(usual)}"
                cpu_part = f"CPU {_cpu_text(cpu)}, {how}"
                if run:
                    add("warn", "cpu_high", f"CPU has been high for {format_span(run['seconds'])}",
                        f"{_cpu_text(cpu)} now{host_bit}, {how}. It has not dropped back to its normal range once in that time, which is a job, not a blip.",
                        at=run["since"])
                    onsets.append((run["since"], "CPU rose"))
                else:
                    add("warn", "cpu_high", "CPU is high right now",
                        f"{_cpu_text(cpu)} now{host_bit}, {how}. It only just started rising, so it may be a short burst.")
                suggestions["logs"] = "Read its logs for what it was doing when the CPU rose."
            else:
                where = "normal for it" if cpu >= usual * 0.5 or usual < 1 else "quieter than usual"
                cpu_part = f"CPU {_cpu_text(cpu)}, {where}"
                add("ok", "cpu_normal", "CPU is in its usual range",
                    f"{_cpu_text(cpu)} now{host_bit}. Usual is {_cpu_text(usual)}, and it stays under {_cpu_text(cpu_base['p90'])} nine times in ten.")
        else:
            cpu_info["level"] = "unknown"
            add("info", "cpu_no_baseline", "Not enough history to say what's normal for its CPU",
                f"{_cpu_text(cpu)} now{host_bit}. Only {history_hours:g} h of history so far, and it needs about {MIN_BASELINE_SECONDS // HOUR} h older than the last two to compare against.")

    # --- memory ---
    mem_part = "No memory reading yet"
    mem_info: dict = {"now": used, "limit": limit or None, "shape": shape["shape"]}
    if used is not None:
        mem_part = f"RAM {format_bytes(used)}"
        percent = (used / limit * 100) if limit else None
        host_share = (used / ram_total) if ram_total else None
        mem_info.update(percent=percent, share_of_host=host_share, usual=mem_base["median"] if mem_base else None)
        host_bit = f" — {host_share * 100:.0f}% of {host}'s RAM" if host_share is not None else ""
        limit_bit = f", {percent:.0f}% of its {format_bytes(limit)} limit" if limit else ", with no memory limit set"
        kind = shape["shape"]

        if kind == "climbing":
            per_hour = shape["per_hour"]
            detail = (f"Up {format_bytes(shape['change_bytes'])} over the last {format_span(shape['window_seconds'])} "
                      f"(about {format_bytes(per_hour)} an hour), almost in a straight line. Now {format_bytes(used)}{limit_bit}{host_bit}.")
            if uptime is not None and uptime <= shape["window_seconds"] + 30 * MINUTE:
                detail += " It has been climbing since it last started."
            if limit and per_hour > 0:
                hours = (limit - used) / per_hour
                mem_info["hours_to_limit"] = hours
                detail += f" At that rate it reaches the limit in about {format_span(hours * HOUR)}."
            add("warn", "mem_climbing", "Memory is climbing steadily", detail)
            mem_part += f", climbing ~{format_bytes(per_hour)}/h"
            suggestions["logs"] = suggestions.get("logs", "Read its logs for what it keeps allocating.")
            suggestions["compose"] = ("Set a memory limit so a leak can't take the host down." if not limit
                                      else "Raise the limit, or restart it to reclaim the memory while you find the cause.")
        elif kind == "stepped":
            direction = "up" if shape["change_bytes"] > 0 else "down"
            add("info" if direction == "up" else "ok", "mem_stepped",
                f"Memory stepped {direction} by {format_bytes(abs(shape['change_bytes']))}",
                f"It moved from about {format_bytes(shape['before'])} to {format_bytes(shape['after'])} "
                f"{format_span(now - shape['at'])} ago and has stayed at the new level since — a one-off load "
                f"(models, a cache, a bigger working set), not a leak. Now {format_bytes(used)}{limit_bit}{host_bit}.",
                at=shape["at"])
            mem_part += f", {'up' if direction == 'up' else 'down'} {format_bytes(abs(shape['change_bytes']))} {format_span(now - shape['at'])} ago"
            onsets.append((shape["at"], "memory stepped"))
        elif kind == "variable":
            add("info", "mem_variable", "Memory swings up and down",
                f"Mostly between {format_bytes(shape['low'])} and {format_bytes(shape['high'])} today; now {format_bytes(used)}{limit_bit}{host_bit}. "
                "That is what caches and batch jobs look like.")
            mem_part += ", swinging"
        elif kind == "falling":
            add("ok", "mem_falling", "Memory is coming down",
                f"Down {format_bytes(abs(shape['change_bytes']))} over {format_span(shape['window_seconds'])}; now {format_bytes(used)}{limit_bit}{host_bit}.")
            mem_part += ", falling"
        elif kind == "steady":
            usual_bit = f" Usual is {format_bytes(mem_base['median'])}." if mem_base else ""
            add("ok", "mem_steady", "Memory is steady",
                f"{format_bytes(used)}{limit_bit}{host_bit}, flat for the last day.{usual_bit} "
                "A flat figure is resident data — loaded models, caches — not growth.")
            mem_part += ", steady"
        else:
            add("info", "mem_no_shape", "Not enough history to see a memory trend",
                f"{format_bytes(used)} now{limit_bit}{host_bit}.")

        if limit and percent is not None and percent >= 90:
            add("bad", "mem_limit", f"Memory is at {percent:.0f}% of its limit",
                f"{format_bytes(used)} of {format_bytes(limit)}. At the limit Docker kills the process (an OOM kill) and the container restarts.")
            suggestions["compose"] = "Raise the memory limit — it is close to being killed."
        elif limit and percent is not None and percent >= 75:
            add("warn", "mem_limit", f"Memory is at {percent:.0f}% of its limit",
                f"{format_bytes(used)} of {format_bytes(limit)}: not critical, but there isn't much headroom for a spike.")
        if limit:
            mem_part += f", {percent:.0f}% of its limit"
        elif used >= 1024 * MEBI:
            suggestions.setdefault("compose", "It has no memory limit; set one so it can't starve its neighbours.")

    # --- what happened around then ---
    for at, label in onsets:
        for event in sorted(_near(events_here, at), key=lambda e: abs(e["at"] - at))[:1]:
            gap = abs(event["at"] - at)
            when = "at the same moment as" if gap < MINUTE else f"within {format_span(gap)} of"
            add("info", "onset_event", f"The {label} {when}: {event['text']}",
                "The timing lines up, so that event is the first place to look.", at=event["at"])

    if uptime is not None and uptime < YOUNG_SECONDS:
        add("info", "young", f"It started {format_span(uptime)} ago",
            "A container that has just started is usually still loading models and warming caches; the numbers settle after a few minutes.")
    restarts = [e for e in events_here if e["kind"] == "container_restart"]
    if len(restarts) >= 2:
        add("warn", "restarts", f"Restarted {len(restarts)} times in the last day",
            "Every start reloads everything, which shows up as bursts of CPU and a memory ramp.")
        suggestions["logs"] = "Read its logs — it is restarting, so the reason is in the lines before each restart."

    # --- the host around it ---
    host_cpu, host_ram = machine.get("cpu"), machine.get("ram")
    loaded = []
    if host_cpu is not None and host_cpu >= HOST_LOADED_PERCENT:
        loaded.append(f"CPU {host_cpu:.0f}%")
    if host_ram is not None and host_ram >= HOST_LOADED_PERCENT:
        loaded.append(f"RAM {host_ram:.0f}%")
    if loaded:
        add("warn", "host_loaded", f"{host} is under load as well",
            f"{', '.join(loaded)} across the whole machine, so this container is competing for what is left.")
    neighbours = _neighbours(peers, name)
    if neighbours and (cpu_info.get("level") == "high" or loaded):
        names = ", ".join(
            f"{n['name']} ({_cpu_text(n['cpu']) if n['cpu'] else format_bytes(n['mem'])})" for n in neighbours[:3]
        )
        add("info", "neighbours", f"Other busy containers on {host}", names)
    gpu = ((machine.get("gpu") or {}).get("devices") or [{}])[0]
    gpu_util = gpu.get("utilization_percent")
    if gpu_util is not None and gpu_util >= 70:
        add("info", "gpu", f"The GPU is busy too ({gpu_util:.0f}%)",
            "If this container (or one beside it, like Ollama) uses the GPU, its CPU side is usually feeding it.")

    # --- what it's moving ---
    moving = []
    for label, value in (("reading", block_io.get("read_bps")), ("writing", block_io.get("write_bps")),
                         ("receiving", network.get("rx_bps")), ("sending", network.get("tx_bps"))):
        if value and value >= IO_NOTABLE_BPS:
            moving.append(f"{label} {format_bytes(value)}/s")
    if moving:
        add("info", "io", "It is moving a lot of data right now", ", ".join(moving) + ". Indexing, importing and transfers look like this.")

    running_backups = [j for j in backup_jobs if j.get("running") and j.get("source_host") == host]
    if running_backups:
        add("info", "backup", f"A backup is running on {host}",
            ", ".join(j.get("name") or "a volume" for j in running_backups) + " — compressing archives costs CPU and disk.")

    live = container.get("live_activity")
    if isinstance(live, dict) and live.get("detail"):
        add("info", "live", f"{live.get('app') or 'The app'} reports activity", str(live["detail"]))

    if any(f["level"] in ("warn", "bad") for f in findings):
        suggestions.setdefault("details", "Open its CPU and memory history to see when it changed.")

    headline = f"{cpu_part}. {mem_part}."
    evidence = {
        "now": {"cpu_percent": cpu, "memory_bytes": used, "memory_limit_bytes": limit or None,
                "net_rx_bps": network.get("rx_bps"), "net_tx_bps": network.get("tx_bps"),
                "disk_read_bps": block_io.get("read_bps"), "disk_write_bps": block_io.get("write_bps"),
                "restart_count": container.get("restart_count"), "uptime_seconds": uptime},
        "usual": {"cpu": cpu_base, "memory": mem_base},
        "history_hours": history_hours,
        "host": {"name": host, "cpu_percent": host_cpu, "ram_percent": host_ram, "vcpu": cores,
                 "ram_total_bytes": ram_total, "gpu_percent": gpu_util},
        "neighbours": neighbours,
        "events": events_here[:8],
    }
    return _result(host, name, now, headline, findings, evidence, suggestions,
                   cpu=cpu_info, memory=mem_info)


_ACTION_ORDER = ["logs", "compose", "details"]


def _result(host, name, now, headline, findings, evidence, suggestions, cpu=None, memory=None) -> dict:
    order = {"bad": 0, "warn": 1, "info": 2, "ok": 3}
    findings = sorted(findings, key=lambda f: order[f["level"]])
    attention = any(f["level"] in ("warn", "bad") for f in findings)
    return {
        "host": host,
        "container": name,
        "generated_at": now,
        "headline": headline,
        "attention": attention,
        "findings": findings,
        "suggestions": [{"action": a, "text": suggestions[a]} for a in _ACTION_ORDER if a in suggestions],
        "cpu": cpu or {},
        "memory": memory or {},
        "evidence": evidence,
    }
