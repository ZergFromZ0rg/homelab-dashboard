"""Request/response models for the deployment scheduler.

A ``DeploymentSpec`` is what the user submits from the Deploy tab. The
scheduler turns the fleet's live stats into a ranked list of
``PlacementResult`` for that spec; deploying persists a ``DeploymentRecord``.
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator

RestartPolicy = Literal["no", "on-failure", "always", "unless-stopped"]
DeploymentStatus = Literal["placing", "running", "failed", "node_offline", "stopped"]
DeploymentKind = Literal["container", "stack"]

# Compose project / container name: what Docker itself accepts.
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class PortMapping(BaseModel):
    container: int = Field(ge=1, le=65535)
    host: int = Field(ge=1, le=65535)
    proto: Literal["tcp", "udp"] = "tcp"


class VolumeMapping(BaseModel):
    # A named volume (``jellyfin-config``) or, if the agent's policy allows
    # it, an allowlisted host path.
    source: str
    target: str
    read_only: bool = False


class ResourceRequest(BaseModel):
    # Both optional. ``cpus`` is fractional cores (2.5 = two and a half
    # cores' worth). ``memory_mb`` is a hard limit and also the RAM the
    # scheduler reserves when scoring.
    cpus: float | None = Field(default=None, gt=0)
    memory_mb: int | None = Field(default=None, gt=0)


class Constraints(BaseModel):
    require_gpu: bool = False
    node_in: list[str] | None = None
    node_not_in: list[str] | None = None
    max_node_cpu_percent: float | None = Field(default=None, ge=0, le=100)
    # Free text from the user. The LLM layer, when enabled, turns this into
    # the structured fields above before scheduling.
    notes: str | None = None


class DeploymentSpec(BaseModel):
    image: str = Field(min_length=1)
    name: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    ports: list[PortMapping] = Field(default_factory=list)
    volumes: list[VolumeMapping] = Field(default_factory=list)
    restart_policy: RestartPolicy = "unless-stopped"
    resources: ResourceRequest = Field(default_factory=ResourceRequest)
    constraints: Constraints = Field(default_factory=Constraints)
    # Set for a synthesised stack placement spec: a disk-footprint override
    # (summed across the stack's images) and a flag that keeps the workload
    # off the rebalancer (a compose project can't be relocated piecemeal).
    image_size_mb_hint: int | None = Field(default=None, gt=0)
    pinned: bool = False

    def stateful(self) -> bool:
        return bool(self.volumes) or self.pinned


class StackSpec(BaseModel):
    name: str
    compose_yaml: str = Field(min_length=1)
    # Written as the project's .env file, so ${VAR} interpolation in the
    # compose file resolves.
    env: dict[str, str] = Field(default_factory=dict)
    constraints: Constraints = Field(default_factory=Constraints)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, value: str) -> str:
        value = value.strip().lower()
        if not NAME_RE.match(value):
            raise ValueError(
                "stack name must be lowercase letters, digits, '-' or '_'"
            )
        return value


class PlacementResult(BaseModel):
    node: str
    eligible: bool
    score: float
    # Ordered, human-readable. Disqualifying reasons first for an
    # ineligible node; scoring factors for an eligible one.
    reasons: list[str] = Field(default_factory=list)
    # Snapshot of what drove the score, for the UI.
    free_ram_mb: int | None = None
    free_cpu_cores: float | None = None
    has_gpu: bool = False


class DeploymentRecord(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    kind: DeploymentKind = "container"
    # For kind="container": the user's spec. For kind="stack": a synthetic
    # spec used only for placement scoring (summed resources, unioned
    # ports, pinned=True); the real definition is in ``stack``.
    spec: DeploymentSpec
    stack: StackSpec | None = None
    status: DeploymentStatus = "placing"
    placed_on: str | None = None
    # A container id for kind="container"; the compose project name for
    # kind="stack".
    agent_container_id: str | None = None
    score: float | None = None
    reason: str | None = None
    alternatives: list[dict] = Field(default_factory=list)
    error: str | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    def touch(self) -> None:
        self.updated_at = time.time()


class PlacementResponse(BaseModel):
    """Return shape for a dry run / preview."""

    spec: DeploymentSpec
    ranked: list[PlacementResult]
    recommended: str | None = None
    explanation: str | None = None
    # Set when the LLM turned ``constraints.notes`` into structured fields.
    parsed_constraints: Constraints | None = None
    warnings: list[str] = Field(default_factory=list)
    # kind="stack" previews echo the parsed service summary.
    stack_services: list[dict] | None = None
