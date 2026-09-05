from backend import rebalance
from backend.models import DeploymentRecord, DeploymentSpec

GB = 1024**3


def machine(cpu=10.0, ram=30.0, cores=8, ram_total_gb=32):
    return {
        "online": True,
        "cpu": cpu,
        "cpu_cores": cores,
        "ram": ram,
        "ram_total_bytes": ram_total_gb * GB,
        "temperature": 45.0,
        "filesystems": [{"mountpoint": "/", "free_bytes": 200 * GB}],
        "gpu": None,
    }


def record(node, *, volumes=None, status="running", cid="abc123"):
    return DeploymentRecord(
        spec=DeploymentSpec(image="nginx:latest", volumes=volumes or []),
        status=status,
        placed_on=node,
        agent_container_id=cid,
    )


def test_suggests_move_off_hot_node():
    machines = {"hot": machine(cpu=92.0), "cool": machine(cpu=8.0)}
    containers = {"hot": [{"id": "abc123", "ports": {}}], "cool": []}
    moves = rebalance.suggest_moves(machines, containers, [record("hot")])
    assert len(moves) == 1
    assert moves[0]["from_node"] == "hot"
    assert moves[0]["to_node"] == "cool"
    assert moves[0]["gain"] >= rebalance.MIN_GAIN


def test_no_suggestion_when_node_is_calm():
    machines = {"a": machine(cpu=40.0), "b": machine(cpu=10.0)}
    containers = {"a": [{"id": "abc123", "ports": {}}], "b": []}
    assert rebalance.suggest_moves(machines, containers, [record("a")]) == []


def test_stateful_container_never_suggested():
    machines = {"hot": machine(cpu=95.0), "cool": machine(cpu=5.0)}
    containers = {"hot": [{"id": "abc123", "ports": {}}], "cool": []}
    dep = record("hot", volumes=[{"source": "data", "target": "/data"}])
    assert rebalance.suggest_moves(machines, containers, [dep]) == []


def test_no_suggestion_when_every_other_node_also_hot():
    machines = {"hot1": machine(cpu=95.0), "hot2": machine(cpu=91.0)}
    containers = {"hot1": [{"id": "abc123", "ports": {}}], "hot2": []}
    assert rebalance.suggest_moves(machines, containers, [record("hot1")]) == []


def test_only_running_deployments_considered():
    machines = {"hot": machine(cpu=95.0), "cool": machine(cpu=5.0)}
    containers = {"hot": [], "cool": []}
    dep = record("hot", status="failed")
    assert rebalance.suggest_moves(machines, containers, [dep]) == []


def test_self_port_not_counted_against_current_node():
    # The container publishes 8096 on its current node; that must not make
    # its own node look ineligible when we score staying put.
    machines = {"hot": machine(cpu=90.0), "cool": machine(cpu=10.0)}
    containers = {
        "hot": [{"id": "abc123", "ports": {"8096/tcp": ["8096"]}}],
        "cool": [],
    }
    dep = DeploymentRecord(
        spec=DeploymentSpec(
            image="nginx:latest",
            ports=[{"container": 8096, "host": 8096}],
        ),
        status="running",
        placed_on="hot",
        agent_container_id="abc123",
    )
    moves = rebalance.suggest_moves(machines, containers, [dep])
    assert len(moves) == 1
    assert moves[0]["to_node"] == "cool"
