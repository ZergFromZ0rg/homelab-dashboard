"""Scheduler scoring is pure arithmetic over dicts — exercise it directly."""

from backend.models import Constraints, DeploymentSpec, ResourceRequest
from backend.scheduler import estimate_image_mb, recommended_node, score_nodes

GB = 1024**3


def machine(
    *,
    online=True,
    cpu=10.0,
    cores=8,
    ram=30.0,
    ram_total_gb=32,
    temp=45.0,
    gpu=False,
    disk_free_gb=200,
):
    return {
        "online": online,
        "cpu": cpu,
        "cpu_cores": cores,
        "ram": ram,
        "ram_total_bytes": ram_total_gb * GB,
        "temperature": temp,
        "filesystems": [{"mountpoint": "/", "free_bytes": disk_free_gb * GB}],
        "gpu": {"devices": [{"temperature_c": 50}]} if gpu else None,
    }


def spec(**kwargs):
    resources = kwargs.pop("resources", None)
    constraints = kwargs.pop("constraints", None)
    base = {"image": "nginx:latest"}
    base.update(kwargs)
    if resources is not None:
        base["resources"] = resources
    if constraints is not None:
        base["constraints"] = constraints
    return DeploymentSpec(**base)


def test_idle_node_beats_busy_node():
    machines = {
        "busy": machine(cpu=85.0, ram=80.0),
        "idle": machine(cpu=5.0, ram=10.0),
    }
    ranked = score_nodes(spec(), machines)
    assert [r.node for r in ranked] == ["idle", "busy"]
    assert recommended_node(ranked) == "idle"
    assert all(r.eligible for r in ranked)


def test_offline_node_is_ineligible_and_last():
    machines = {"up": machine(), "down": machine(online=False)}
    ranked = score_nodes(spec(), machines)
    assert ranked[-1].node == "down"
    assert ranked[-1].eligible is False
    assert "offline" in ranked[-1].reasons[0]


def test_require_gpu_disqualifies_gpu_less_nodes():
    machines = {
        "plain": machine(gpu=False),
        "accel": machine(gpu=True, cpu=60.0),
    }
    ranked = score_nodes(
        spec(constraints=Constraints(require_gpu=True)), machines
    )
    assert recommended_node(ranked) == "accel"
    plain = next(r for r in ranked if r.node == "plain")
    assert plain.eligible is False


def test_gpu_node_penalised_for_non_gpu_workload():
    machines = {
        "plain": machine(gpu=False),
        "accel": machine(gpu=True),
    }
    ranked = score_nodes(spec(), machines)
    assert recommended_node(ranked) == "plain"
    accel = next(r for r in ranked if r.node == "accel")
    assert any("GPU" in reason for reason in accel.reasons)


def test_memory_request_larger_than_free_ram_disqualifies():
    machines = {
        "small": machine(ram=90.0, ram_total_gb=8),  # ~0.8 GB free
        "big": machine(ram=20.0, ram_total_gb=64),  # ~51 GB free
    }
    ranked = score_nodes(
        spec(resources=ResourceRequest(memory_mb=4096)), machines
    )
    assert recommended_node(ranked) == "big"
    small = next(r for r in ranked if r.node == "small")
    assert small.eligible is False
    assert "MB RAM free" in small.reasons[0]


def test_cpu_request_over_core_count_disqualifies():
    machines = {"quad": machine(cores=4), "many": machine(cores=16)}
    ranked = score_nodes(
        spec(resources=ResourceRequest(cpus=8)), machines
    )
    assert recommended_node(ranked) == "many"
    assert next(r for r in ranked if r.node == "quad").eligible is False


def test_node_not_in_excludes():
    machines = {"a": machine(), "b": machine()}
    ranked = score_nodes(
        spec(constraints=Constraints(node_not_in=["a"])), machines
    )
    assert recommended_node(ranked) == "b"
    assert next(r for r in ranked if r.node == "a").eligible is False


def test_max_node_cpu_percent_ceiling():
    machines = {"hot": machine(cpu=70.0), "cool": machine(cpu=15.0)}
    ranked = score_nodes(
        spec(constraints=Constraints(max_node_cpu_percent=50)), machines
    )
    assert recommended_node(ranked) == "cool"
    assert next(r for r in ranked if r.node == "hot").eligible is False


def test_stale_host_penalised_but_still_eligible():
    machines = {"fresh": machine(cpu=40.0), "stale": machine(cpu=5.0)}
    # 'stale' is idler so without the penalty it would win.
    ranked = score_nodes(spec(), machines, stale_hosts={"stale"})
    stale = next(r for r in ranked if r.node == "stale")
    assert stale.eligible is True
    assert any("stale" in reason for reason in stale.reasons)


def test_hot_node_penalised():
    machines = {"hot": machine(temp=85.0), "cool": machine(temp=40.0)}
    ranked = score_nodes(spec(), machines)
    assert recommended_node(ranked) == "cool"


def test_disk_too_full_disqualifies_for_large_image():
    machines = {
        "full": machine(disk_free_gb=1),
        "roomy": machine(disk_free_gb=100),
    }
    ranked = score_nodes(spec(image="pytorch/pytorch:latest"), machines)
    assert recommended_node(ranked) == "roomy"
    assert next(r for r in ranked if r.node == "full").eligible is False


def test_all_ineligible_recommends_none():
    machines = {"down": machine(online=False)}
    ranked = score_nodes(spec(), machines)
    assert recommended_node(ranked) is None


def test_estimate_image_mb_hint_and_default():
    assert estimate_image_mb("alpine:3.20") == 20
    assert estimate_image_mb("lscr.io/linuxserver/jellyfin") == 1300
    assert estimate_image_mb("some/unknown-image:tag") == 500
