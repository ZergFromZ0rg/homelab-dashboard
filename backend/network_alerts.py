"""Everything on the network worth an alert: Pi-hole and the devices on it,
the switch and its ports, and the internet's speed."""

from backend import pihole_alerts, speedtest, switch


def current() -> dict[str, dict]:
    return {**pihole_alerts.current(), **switch.alerts(), **speedtest.alerts()}
