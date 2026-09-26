from backend import node_details


def _fake(results):
    def query(promql):
        for key, rows in results.items():
            if key in promql:
                return rows
        return []
    return query


def row(value, **labels):
    return {"metric": {"job": "bigboy", **labels}, "value": [0, str(value)]}


def test_collects_what_exists_and_skips_the_rest(monkeypatch):
    node_details._cache = None
    monkeypatch.setattr(
        node_details.prometheus,
        "query",
        _fake(
            {
                "node_os_info": [row(1, pretty_name="Debian 13")],
                "node_load5": [row(0.5)],
                'mode="idle"': [row(10, cpu="1"), row(30, cpu="0")],
                "by(job, mode)": [row(3.14159, mode="user")],
                "files_free": [row("NaN", mountpoint="/boot/efi"), row(12.34, mountpoint="/")],
                "node_hwmon_chip_names": [row(1, chip="pci0", chip_name="k10temp")],
                "node_hwmon_temp_celsius": [row(58.26, chip="pci0", sensor="temp1")],
            }
        ),
    )

    d = node_details.get()["bigboy"]

    assert d["os"] == "Debian 13"
    assert d["load5"] == 0.5
    assert d["per_core"] == [30.0, 10.0]  # ordered by core index
    assert d["cpu_modes"] == {"user": 3.1}
    assert d["inodes_used"] == {"/": 12.3}  # NaN dropped, not sent as JSON NaN
    assert d["sensors"] == [{"chip": "k10temp", "sensor": "temp1", "celsius": 58.3}]
    assert "swap_total" not in d  # missing metric: left out, not an error


def test_is_cached(monkeypatch):
    node_details._cache = None
    calls = []

    def query(promql):
        calls.append(promql)
        return []

    monkeypatch.setattr(node_details.prometheus, "query", query)
    node_details.get()
    first = len(calls)
    node_details.get()
    assert len(calls) == first
