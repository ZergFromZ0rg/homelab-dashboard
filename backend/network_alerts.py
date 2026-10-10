"""Everything on the network worth an alert: Pi-hole and the devices on it,
and the switch and its ports."""

from backend import pihole_alerts, switch


def current() -> dict[str, dict]:
    return {**pihole_alerts.current(), **switch.alerts()}
