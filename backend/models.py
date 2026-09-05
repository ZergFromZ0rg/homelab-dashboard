"""Request/response models for the deployment scheduler.

A ``DeploymentSpec`` is what the user submits from the Deploy tab. The
scheduler turns the fleet's live stats into a ranked list of
``PlacementResult`` for that spec; deploying persists a ``DeploymentRecord``.
"""

from __future__ import annotations

import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field

RestartPolicy = Literal["no", "on-failure", "always", "unless-stopped"]
DeploymentStatus = Literal["placing", "running", "failed", "node_offline", "stopped"]


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

    def stateful(self) -> bool:
        return bool(self.volumes)


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
    spec: DeploymentSpec
    status: DeploymentStatus = "placing"
    placed_on: str | None = None
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
