"""Glue between a ``StackSpec`` (compose YAML + env) and the rest of the
scheduler, which only knows how to score a single ``DeploymentSpec``.

``plan_stack`` parses the compose file and synthesises a placement spec:
the stack's services co-locate (they share the project network), so the
node has to fit the *sum* of their resource limits and the *union* of
their published ports. The synthetic spec is ``pinned`` so the rebalancer
leaves compose projects alone.
"""

from __future__ import annotations

from backend.compose import ParsedStack, parse_stack
from backend.models import Constraints, DeploymentSpec, PortMapping, ResourceRequest, StackSpec
from backend.scheduler import estimate_image_mb


def estimate_stack_mb(parsed: ParsedStack) -> int:
    total = sum(estimate_image_mb(image) for image in parsed.images)
    return total or estimate_image_mb("")


def plan_stack(stack: StackSpec) -> tuple[DeploymentSpec, ParsedStack, list[str]]:
    parsed = parse_stack(stack.compose_yaml)
    warnings: list[str] = []

    if parsed.bind_mounts:
        warnings.append(
            "compose file bind-mounts host paths ("
            + ", ".join(sorted(set(parsed.bind_mounts))[:4])
            + ") — the agent only allows those under ALLOWED_HOST_PATHS; "
            "prefer named volumes"
        )

    services_without_image = [s.name for s in parsed.services if not s.image]
    if services_without_image:
        warnings.append(
            "services build from source rather than a pulled image ("
            + ", ".join(services_without_image)
            + ") — the agent needs the build context and may reject it"
        )

    if parsed.total_memory_mb is None:
        warnings.append(
            "no memory limits in the compose file — placement can't reserve "
            "RAM for this stack; add deploy.resources.limits.memory per service"
        )

    spec = DeploymentSpec(
        image=f"stack:{stack.name}",
        name=stack.name,
        ports=[
            PortMapping(container=port, host=port) for port in parsed.host_ports
        ],
        resources=ResourceRequest(
            cpus=parsed.total_cpus,
            memory_mb=parsed.total_memory_mb,
        ),
        constraints=stack.constraints,
        image_size_mb_hint=estimate_stack_mb(parsed),
        pinned=True,
    )
    return spec, parsed, warnings


def agent_stack_payload(stack: StackSpec) -> dict:
    return {
        "name": stack.name,
        "compose_yaml": stack.compose_yaml,
        "env": dict(stack.env),
    }


def service_summary(parsed: ParsedStack) -> list[dict]:
    return [
        {
            "name": s.name,
            "image": s.image,
            "host_ports": s.host_ports,
            "memory_mb": s.memory_mb,
            "cpus": s.cpus,
        }
        for s in parsed.services
    ]
