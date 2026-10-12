"""The address put in container links: an IP or dotted name the agent registered
when there is one, the node name when the agent is only a Docker alias."""

from backend.registry import browse_host


def test_a_registered_ip_is_used_as_is():
    assert browse_host("bigboy", "http://100.72.159.83:8123") == "100.72.159.83"


def test_a_dotted_name_is_used_as_is():
    assert browse_host("bigboy", "http://bigboy.tail0179f8.ts.net:8123") == "bigboy.tail0179f8.ts.net"


def test_a_docker_alias_falls_back_to_the_node_name():
    assert browse_host("thinkpad", "http://homelab-agent:8123") == "thinkpad"


def test_addresses_a_browser_cannot_use_fall_back_to_the_node_name():
    assert browse_host("thinkpad", "http://127.0.0.1:8123") == "thinkpad"
    assert browse_host("thinkpad", "http://169.254.1.1:8123") == "thinkpad"
    assert browse_host("thinkpad", "http://[fd7a:115c:a1e0::1]:8123") == "thinkpad"


def test_a_missing_url_falls_back_to_the_node_name():
    assert browse_host("thinkpad", "") == "thinkpad"
