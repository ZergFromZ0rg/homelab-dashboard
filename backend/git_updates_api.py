"""Fleet discovery and per-project opt-in for automatic source deployments."""

from fastapi import APIRouter, Header, HTTPException

from backend import auth, git_updates
from backend.hosts import agent_for
from backend.registry import registry

router = APIRouter()


@router.get("/api/git-updates")
def discover_git_updates(x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return git_updates.discover(registry.all())


@router.put("/api/git-updates/{host}/{project_id}")
def set_git_updates(
    host: str, project_id: str, payload: dict,
    x_register_token: str | None = Header(default=None),
):
    auth.check_token(x_register_token)
    auth.require_elevated()
    if set(payload) != {"enabled"} or type(payload["enabled"]) is not bool:
        raise HTTPException(status_code=400, detail="Provide enabled as true or false.")
    # IDs are agent-generated, never a path the client can choose to execute.
    if not project_id or len(project_id) > 128 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in project_id):
        raise HTTPException(status_code=400, detail="Invalid repository ID.")
    try:
        return git_updates.set_enabled(agent_for(host), project_id, payload["enabled"])
    except git_updates.GitUpdateError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
