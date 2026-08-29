import os
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

AGENTS = {
    "thinkpad": os.getenv("THINKPAD_AGENT_URL", "http://localhost:8123"),
    "bigboy": os.getenv("BIGBOY_AGENT_URL", "http://localhost:8123"),
}


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
        }

    except requests.RequestException as error:
        print(f"Agent error for {host}: {error}")

        return host, {
            "containers": [],
            "gpu": None,
            "updated_at": None,
        }


def get_all_containers():
    hosts = {}

    with ThreadPoolExecutor(max_workers=len(AGENTS)) as executor:
        futures = [
            executor.submit(
                get_host_data,
                host,
                base_url,
            )
            for host, base_url in AGENTS.items()
        ]

        for future in as_completed(futures):
            host, data = future.result()
            hosts[host] = data

    return hosts


def control_container(host: str, container_id: str, action: str):
    if host not in AGENTS:
        raise ValueError("Unknown host")

    if action not in {"start", "stop", "restart"}:
        raise ValueError("Invalid action")

    response = requests.post(
        f"{AGENTS[host]}/containers/{container_id}/{action}",
        timeout=15,
    )

    response.raise_for_status()
    return response.json()
