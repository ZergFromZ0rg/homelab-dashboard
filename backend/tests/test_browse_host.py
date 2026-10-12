"""The address put in container links: an IP or dotted name the agent registered
when there is one, otherwise None, which the page reads as "the address you
opened the dashboard at" (a Docker alias means the dashboard's own machine)."""

from backend.registry import browse_host


def test_a_registered_ip_is_used_as_is():
    assert browse_host("http://100.72.159.83:8123") == "100.72.159.83"


def test_a_dotted_name_is_used_as_is():
    assert browse_host("http://bigboy.tail0179f8.ts.net:8123") == "bigboy.tail0179f8.ts.net"


def test_a_docker_alias_means_the_dashboards_own_machine():
    assert browse_host("http://homelab-agent:8123") is None


def test_addresses_a_browser_cannot_use_are_none():
    assert browse_host("http://127.0.0.1:8123") is None
    assert browse_host("http://169.254.1.1:8123") is None
    assert browse_host("http://[fd7a:115c:a1e0::1]:8123") is None


def test_a_missing_url_is_none():
    assert browse_host("") is None
