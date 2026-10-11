"""Everything on the network worth an alert: Pi-hole and the devices on it,
the switch and its ports, the internet's speed and the router's link."""

from backend import pihole_alerts, speedtest, switch, wan


def current() -> dict[str, dict]:
    return {**pihole_alerts.current(), **switch.alerts(), **speedtest.alerts(), **wan.alerts()}
