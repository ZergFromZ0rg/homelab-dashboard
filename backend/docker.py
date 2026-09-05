import os
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

CONTROL_ACTIONS = {"start", "stop", "restart"}

# How long to give an agent to pull an image and start the container.
# Image pulls dominate this; a cold pull of a multi-GB image is slow.
DEPLOY_TIMEOUT_SECONDS = 600

# Sent as X-Agent-Token to agents that set AGENT_TOKEN. One shared secret
# for the whole fleet is fine for a homelab.
AGENT_TOKEN = os.getenv("AGENT_TOKEN", "").strip()


def _agent_headers() -> dict:
    return {"X-Agent-Token": AGENT_TOKEN} if AGENT_TOKEN else {}


def get_host_data(host, base_url):
    try:
        response = requests.get(
            f"{base_url}/containers",
            timeout=5,
        )

        response.raise_for_status()
        data = response.json()

        return host, {
            "containers": data.get("containers", []),
            "gpu": data.get("gpu"),
            "updated_at": data.get("updated_at"),
            "reachable": True,
        }

    except requests.RequestException as error:
        print(f"Agent error for {host}: {error}")

        return host, {
            "containers": [],
            "gpu": None,
            "updated_at": None,
            "reachable": False,
        }


def get_all_containers(nodes):
    """Fetch every registered agent's container/GPU snapshot.

    ``nodes`` is the registry mapping ``name -> {"url": ...}``.
    """
    hosts = {}

    if not nodes:
        return hosts

    with ThreadPoolExecutor(max_workers=min(16, len(nodes))) as executor:
        futures = [
            executor.submit(
                get_host_data,
                name,
                info["url"].rstrip("/"),
            )
            for name, info in nodes.items()
        ]

        for future in as_completed(futures):
            host, data = future.result()
            hosts[host] = data

    return hosts


def control_container(nodes, host: str, container_id: str, action: str):
    if host not in nodes:
        raise ValueError("Unknown host")

    if action not in CONTROL_ACTIONS:
        raise ValueError("Invalid action")

    base_url = nodes[host]["url"].rstrip("/")

    response = requests.post(
        f"{base_url}/containers/{container_id}/{action}",
        headers=_agent_headers(),
        timeout=15,
    )

    response.raise_for_status()
    return response.json()


def _agent_url(nodes: dict, host: str) -> str:
    if host not in nodes:
        raise ValueError("Unknown host")
    return nodes[host]["url"].rstrip("/")


def deploy_container(nodes: dict, host: str, spec_payload: dict) -> dict:
    """POST a container spec to a node's agent for it to pull and run.

    ``spec_payload`` is ``DeploymentSpec.model_dump()`` reshaped into the
    agent's ``POST /containers`` body. Returns the agent's JSON response
    ``{success, id, name, image_digest}`` (or ``{success: False, error,
    stage}``). Raises ``ValueError`` for an unknown host and
    ``requests.RequestException`` if the agent is unreachable.
    """
    base_url = _agent_url(nodes, host)

    response = requests.post(
        f"{base_url}/containers",
        json=spec_payload,
        headers=_agent_headers(),
        timeout=DEPLOY_TIMEOUT_SECONDS,
    )

    # An agent from before the deploy endpoint existed has no route here.
    if response.status_code == 404:
        return {
            "success": False,
            "error": (
                "this agent has no POST /containers route — update "
                "homelab-agent on that host to a build with deploy.py"
            ),
            "stage": "policy",
        }

    # The agent reports pull/create/start failures as a 4xx/5xx with a JSON
    # body; surface that body rather than a bare status code.
    if response.status_code >= 400:
        try:
            return {"success": False, **response.json()}
        except ValueError:
            response.raise_for_status()

    return response.json()


def remove_container(nodes: dict, host: str, container_id: str) -> dict:
    """Ask a node's agent to stop and delete a container."""
    base_url = _agent_url(nodes, host)

    response = requests.delete(
        f"{base_url}/containers/{container_id}",
        headers=_agent_headers(),
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def agent_spec_payload(spec: dict) -> dict:
    """Reshape a ``DeploymentSpec`` dump into the agent's request body."""
    resources = spec.get("resources") or {}
    return {
        "image": spec["image"],
        "name": spec.get("name"),
        "env": spec.get("env") or {},
        "ports": [
            {
                "container": p["container"],
                "host": p["host"],
                "proto": p.get("proto", "tcp"),
            }
            for p in spec.get("ports") or []
        ],
        "volumes": [
            {
                "source": v["source"],
                "target": v["target"],
                "read_only": v.get("read_only", False),
            }
            for v in spec.get("volumes") or []
        ],
        "restart_policy": spec.get("restart_policy", "unless-stopped"),
        "resources": {
            "cpus": resources.get("cpus"),
            "memory_mb": resources.get("memory_mb"),
        },
        "labels": {"deployed-by": "homelab-dashboard"},
        "pull": True,
    }
