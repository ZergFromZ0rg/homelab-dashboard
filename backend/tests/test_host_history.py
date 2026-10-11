"""Host history: the queries Prometheus is asked, and what is made of its answers."""

import re

import requests
from fastapi.testclient import TestClient

from backend import host_history, main, prometheus

NOW = 2_000_000.0


class Prom:
    def __init__(self, monkeypatch, jobs=("bigboy", "thinkpad"), fail=None):
        self.asked = []
        self.fail = fail
        monkeypatch.setattr(prometheus, "list_jobs", lambda: list(jobs))
        monkeypatch.setattr(prometheus, "query_range", self.query_range)
        monkeypatch.setattr(prometheus, "_cpu_chip_ids_by_job", lambda: {"bigboy": {"platform_coretemp_0"}})

    def query_range(self, promql, start, end, step):
        if self.fail:
            raise self.fail
        self.asked.append((promql, start, end, step))
        values = [[start, "1.5"], [start + step, "NaN"], [start + 2 * step, "3"]]
        if "node_filesystem_size_bytes" in promql:
            return [
                {"metric": {"mountpoint": "/", "device": "/dev/nvme0n1p2"}, "values": values},
                {"metric": {"mountpoint": "/etc/hosts", "device": "/dev/nvme0n1p2"}, "values": values},  # bind mount
                {"metric": {"mountpoint": "/boot/efi", "device": "/dev/nvme0n1p1"}, "values": values},  # skipped mount
                {"metric": {"mountpoint": "/mnt/media", "device": "/dev/sda1"}, "values": values},
            ]
        return [{"metric": {}, "values": values}]

    def query_for(self, fragment):
        return next(q for q in self.asked if fragment in q[0])


def test_each_range_asks_prometheus_for_about_three_hundred_points():
    for key, (span, step) in host_history.RANGES.items():
        assert 200 <= span / step <= 400, key


def test_a_point_is_the_average_over_its_step_not_one_sample(monkeypatch):
    prom = Prom(monkeypatch)
    out = host_history.get("bigboy", "7d", NOW)
    promql, start, end, step = prom.query_for("node_cpu_seconds_total")
    assert step == 1800 and f"[{max(step, 120)}s]" in promql and (end - start) == 7 * 86400
    assert out["series"]["cpu"] == [{"t": int(start), "v": 1.5}, {"t": int(start + step), "v": None}, {"t": int(start + 2 * step), "v": 3.0}]


def test_the_window_is_never_shorter_than_two_minutes(monkeypatch):
    prom = Prom(monkeypatch)
    host_history.get("bigboy", "6h", NOW)
    assert "[120s]" in prom.query_for("node_cpu_seconds_total")[0]


def test_temperature_is_the_peak_of_the_cpu_chips_only(monkeypatch):
    prom = Prom(monkeypatch)
    host_history.get("bigboy", "24h", NOW)
    promql = prom.query_for("node_hwmon_temp_celsius")[0]
    assert promql.startswith("max(max_over_time(") and 'chip=~"platform_coretemp_0"' in promql and "< 115" in promql
    host_history.get("thinkpad", "24h", NOW)  # no known CPU chip: every sensor on the host
    assert "chip=~" not in [q for q in prom.asked if 'job="thinkpad"' in q[0] and "hwmon" in q[0]][0][0]


def test_network_totals_leave_out_virtual_interfaces(monkeypatch):
    prom = Prom(monkeypatch)
    host_history.get("bigboy", "24h", NOW)
    for fragment in ("receive_bytes", "transmit_bytes"):
        assert "tailscale" in prom.query_for(fragment)[0] and "veth" in prom.query_for(fragment)[0]


def test_disks_drop_pseudo_mounts_and_bind_mount_duplicates(monkeypatch):
    Prom(monkeypatch)
    disks = host_history.get("bigboy", "24h", NOW)["series"]["disks"]
    assert [d["mountpoint"] for d in disks] == ["/", "/mnt/media"]


def test_a_host_with_no_node_exporter_job_still_answers_with_its_gpu(monkeypatch):
    Prom(monkeypatch, jobs=("thinkpad",))
    out = host_history.get("bigboy", "24h", NOW)
    assert out["prometheus"] is False and out["series"] == {} and out["gpus"] == []


def test_prometheus_down_is_said_not_hidden(monkeypatch):
    Prom(monkeypatch, fail=requests.ConnectionError("refused"))
    out = host_history.get("bigboy", "24h", NOW)
    assert out["prometheus"] is False and "refused" in out["error"]


def test_a_host_name_that_could_alter_the_query_is_never_sent(monkeypatch):
    prom = Prom(monkeypatch, jobs=('x"} or vector(1) #',))
    out = host_history.get('x"} or vector(1) #', "24h", NOW)
    assert out["prometheus"] is False and prom.asked == []


def test_the_route_validates_the_range(monkeypatch):
    Prom(monkeypatch)
    client = TestClient(main.app)
    assert client.get("/api/host-history/bigboy?range=5y").status_code == 400
    body = client.get("/api/host-history/bigboy?range=24h").json()
    assert body["range"] == "24h" and set(body["series"]) >= {"cpu", "ram", "load", "temperature", "network_rx", "disks"}


def test_it_does_not_swallow_the_history_settings_routes(monkeypatch):
    Prom(monkeypatch)
    assert "audit_days" in TestClient(main.app).get("/api/history/settings").json()
