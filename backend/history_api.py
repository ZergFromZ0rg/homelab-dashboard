"""Long-range history for one host."""

from fastapi import APIRouter, HTTPException

from backend import host_history

# Not /api/history/...: that prefix already holds the history *settings* routes.
router = APIRouter(prefix="/api/host-history")


@router.get("/{host}")
def history(host: str, range: str = "24h"):
    """Off the /ws payload on purpose: it is only wanted while someone has the
    History view open, and months of points do not belong in a 2-second stream."""
    try:
        return host_history.get(host, range)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
