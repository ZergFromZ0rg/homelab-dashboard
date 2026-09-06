import pytest

from backend.compose import ComposeError, parse_stack

MEDIA = """
services:
  jellyfin:
    image: lscr.io/linuxserver/jellyfin:latest
    ports:
      - "8096:8096"
      - "127.0.0.1:8920:8920/tcp"
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: "2.0"
    volumes:
      - jellyfin-config:/config
  redis:
    image: redis:7
    mem_limit: 256m
    cpus: 0.5
volumes:
  jellyfin-config:
"""


def test_parses_services_ports_and_resources():
    stack = parse_stack(MEDIA)
    assert {s.name for s in stack.services} == {"jellyfin", "redis"}
    assert stack.host_ports == [8096, 8920]
    assert stack.total_memory_mb == 2048 + 256
    assert stack.total_cpus == 2.5
    assert stack.stateful is True
    assert "lscr.io/linuxserver/jellyfin:latest" in stack.images


def test_bind_mounts_flagged():
    stack = parse_stack(
        """
services:
  app:
    image: nginx
    volumes:
      - ./html:/usr/share/nginx/html
      - /etc/localtime:/etc/localtime:ro
      - data:/data
"""
    )
    svc = stack.services[0]
    assert sorted(svc.bind_mounts) == ["./html", "/etc/localtime"]
    assert svc.named_volumes == ["data"]
    assert stack.stateful is True


def test_long_form_ports():
    stack = parse_stack(
        """
services:
  web:
    image: nginx
    ports:
      - target: 80
        published: 8080
        protocol: tcp
"""
    )
    assert stack.host_ports == [8080]


def test_container_only_port_is_not_a_clash():
    stack = parse_stack(
        "services:\n  x:\n    image: nginx\n    ports:\n      - \"80\"\n"
    )
    assert stack.host_ports == []


def test_no_limits_means_none():
    stack = parse_stack("services:\n  x:\n    image: nginx\n")
    assert stack.total_memory_mb is None
    assert stack.total_cpus is None
    assert stack.stateful is False


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "not: [a, mapping", "just a string", "services: {}", "version: '3'"],
)
def test_invalid_compose_raises(bad):
    with pytest.raises(ComposeError):
        parse_stack(bad)


def test_memory_unit_parsing():
    stack = parse_stack(
        """
services:
  a:
    image: x
    mem_limit: 1g
  b:
    image: y
    mem_limit: 512000000
"""
    )
    # 1 GiB + ~488 MiB
    assert stack.total_memory_mb == 1024 + 488
