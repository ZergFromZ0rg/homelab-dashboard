import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

CONTROL_ACTIONS = {"start", "stop", "restart"}


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
        timeout=15,
    )

    response.raise_for_status()
    return response.json()
