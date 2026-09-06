"""Best-effort extraction of the few things the scheduler needs from a
Compose file: per-service image, published host ports, and resource
limits. Everything the parser can't make sense of falls back to a default
— same philosophy as the single-container image-size guess. The agent
runs the real ``docker compose`` for full fidelity; this is only for
scoring and for warning the user before they deploy.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import yaml


class ComposeError(ValueError):
    pass


@dataclass
class ParsedService:
    name: str
    image: str | None
    host_ports: list[int] = field(default_factory=list)
    memory_mb: int | None = None
    cpus: float | None = None
    bind_mounts: list[str] = field(default_factory=list)  # host paths (policy risk)
    named_volumes: list[str] = field(default_factory=list)


@dataclass
class ParsedStack:
    services: list[ParsedService]
    top_level_volumes: list[str] = field(default_factory=list)

    @property
    def total_memory_mb(self) -> int | None:
        vals = [s.memory_mb for s in self.services if s.memory_mb]
        return sum(vals) if vals else None

    @property
    def total_cpus(self) -> float | None:
        vals = [s.cpus for s in self.services if s.cpus]
        return round(sum(vals), 2) if vals else None

    @property
    def host_ports(self) -> list[int]:
        seen: list[int] = []
        for service in self.services:
            for port in service.host_ports:
                if port not in seen:
                    seen.append(port)
        return sorted(seen)

    @property
    def images(self) -> list[str]:
        return [s.image for s in self.services if s.image]

    @property
    def bind_mounts(self) -> list[str]:
        out: list[str] = []
        for service in self.services:
            out.extend(service.bind_mounts)
        return out

    @property
    def stateful(self) -> bool:
        return bool(self.top_level_volumes) or any(
            s.named_volumes or s.bind_mounts for s in self.services
        )


def _parse_memory(value) -> int | None:
    """Compose memory string (``512m``, ``1g``, ``1.5G``, bytes int) -> MB."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return max(1, int(value / (1024 * 1024)))
    text = str(value).strip().lower()
    if not text:
        return None
    units = {"b": 1 / (1024 * 1024), "k": 1 / 1024, "m": 1, "g": 1024, "t": 1024 * 1024}
    suffix = text[-1]
    try:
        if suffix in units:
            return max(1, int(float(text[:-1]) * units[suffix]))
        return max(1, int(float(text) / (1024 * 1024)))
    except ValueError:
        return None


def _parse_cpus(value) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _published_port(entry) -> int | None:
    # Long form: {target: 80, published: 8080, ...}
    if isinstance(entry, dict):
        published = entry.get("published")
        try:
            return int(str(published).split("-")[0]) if published is not None else None
        except ValueError:
            return None

    # Short form: "8080:80", "127.0.0.1:8080:80", "8080:80/tcp", "80"
    text = str(entry).split("/")[0]
    parts = text.split(":")
    if len(parts) == 1:
        return None  # only a container port -> random host port, nothing to clash
    candidate = parts[-2]
    try:
        return int(candidate.split("-")[0])
    except ValueError:
        return None


def _service_resources(service: dict) -> tuple[int | None, float | None]:
    memory_mb = _parse_memory(service.get("mem_limit"))
    cpus = _parse_cpus(service.get("cpus"))

    deploy = service.get("deploy") or {}
    limits = (deploy.get("resources") or {}).get("limits") or {}
    if memory_mb is None:
        memory_mb = _parse_memory(limits.get("memory"))
    if cpus is None:
        cpus = _parse_cpus(limits.get("cpus"))

    return memory_mb, cpus


def _split_volumes(service: dict) -> tuple[list[str], list[str]]:
    """(bind_mount_host_paths, named_volume_names) for a service."""
    binds: list[str] = []
    named: list[str] = []
    for entry in service.get("volumes") or []:
        if isinstance(entry, dict):
            source = entry.get("source")
            if entry.get("type") == "bind" or (source and source.startswith((".", "/", "~"))):
                if source:
                    binds.append(source)
            elif source:
                named.append(source)
            continue
        source = str(entry).split(":")[0]
        if source.startswith((".", "/", "~")):
            binds.append(source)
        else:
            named.append(source)
    return binds, named


def parse_stack(yaml_text: str) -> ParsedStack:
    if not yaml_text or not yaml_text.strip():
        raise ComposeError("empty compose file")

    try:
        doc = yaml.safe_load(io.StringIO(yaml_text))
    except yaml.YAMLError as error:
        raise ComposeError(f"invalid YAML: {error}") from error

    if not isinstance(doc, dict):
        raise ComposeError("compose file must be a mapping")

    services_block = doc.get("services")
    if not isinstance(services_block, dict) or not services_block:
        raise ComposeError("no services defined")

    services: list[ParsedService] = []
    for name, raw in services_block.items():
        service = raw if isinstance(raw, dict) else {}
        memory_mb, cpus = _service_resources(service)
        binds, named = _split_volumes(service)
        ports = [
            port
            for port in (_published_port(p) for p in service.get("ports") or [])
            if port is not None
        ]
        services.append(
            ParsedService(
                name=str(name),
                image=service.get("image"),
                host_ports=ports,
                memory_mb=memory_mb,
                cpus=cpus,
                bind_mounts=binds,
                named_volumes=named,
            )
        )

    top_volumes = list((doc.get("volumes") or {}).keys()) if isinstance(
        doc.get("volumes"), dict
    ) else []

    return ParsedStack(services=services, top_level_volumes=top_volumes)
