"""The routes that don't touch a host: pins, notes, to-dos, the Personal
tab's providers, alert and activity history, and the stored credentials
for live-activity probes. The stores live here; main.py reads pins and
to-dos into every /ws tick."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from backend import activity, alert_history, audit_log, auth, history_settings, notify, personal
from backend.notes import Conflict, NoteStore
from backend.pins import PinStore
from backend.service_activity_credentials import ServiceActivityCredentialStore
from backend.todos import TodoStore

router = APIRouter()

pins = PinStore()
todos = TodoStore()
notes = NoteStore()
service_activity_credentials = ServiceActivityCredentialStore()


# AUTH: the routes below (pins, notes, to-dos) are deliberately *not*
# gated. They are this browser's view state and personal scratch space —
# nothing they change reaches a host. Everything that does touch a host is
# gated, so turning auth on is one environment variable rather than an
# audit. See "Authentication" in the README.
@router.get("/api/pins")
def list_pins():
    """Containers the user pinned to the top of the Containers tab. Pure UI
    state, shared across browsers; also included in every /ws tick."""
    return {"pins": pins.all()}


@router.put("/api/pins")
def set_pins(payload: dict):
    keys = payload.get("pins")
    if not isinstance(keys, list):
        raise HTTPException(status_code=400, detail="'pins' must be a list of strings")
    return {"pins": pins.replace(keys)}


@router.get("/api/service-activity-credentials")
def get_service_activity_credentials():
    """Which service_activity apps have credentials configured — never
    the credential values themselves (write-only from the API's point of
    view). Not part of the /ws payload — fetched once when Settings
    opens, not something that needs to stream."""
    return {"configured": service_activity_credentials.configured()}


@router.put("/api/service-activity-credentials")
def set_service_activity_credentials(
    payload: dict,
    x_register_token: str | None = Header(default=None),
):
    """AUTH: gated — this stores service passwords and API keys.

    Body: {"app": "qbittorrent", "credentials": {"username": ..., "password": ...}}
    (or {"app": "jellyfin", "credentials": {"api_key": ...}}). Merges into
    that app's stored fields — a blank value clears just that field."""
    auth.check_token(x_register_token)

    app_name = payload.get("app")
    fields = payload.get("credentials")

    if not isinstance(fields, dict):
        raise HTTPException(status_code=400, detail="'credentials' must be an object")

    try:
        service_activity_credentials.set(app_name, fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return {"configured": service_activity_credentials.configured()}


@router.delete("/api/service-activity-credentials/{app_name}")
def clear_service_activity_credentials(
    app_name: str,
    x_register_token: str | None = Header(default=None),
):
    """AUTH: gated — see the PUT above."""
    auth.check_token(x_register_token)
    service_activity_credentials.clear(app_name)
    return {"configured": service_activity_credentials.configured()}


@router.get("/api/alerts")
def list_alerts():
    """What the alert monitor has fired, newest first. An entry with a
    null ``resolved_at`` is still firing."""
    return {"alerts": alert_history.recent()}


@router.get("/api/activity")
def list_activity(limit: int = Query(200, ge=1, le=2000), before: float | None = None, q: str | None = None):
    """Fleet events (container/host/deploy transitions), newest first. The
    latest ride every /ws tick; this pages back through the history."""
    return {"activity": activity.history(limit, before, q)}


def _personal(fn, *args):
    """Run a Personal-tab provider call; a dead upstream is a 502, bad
    input (already range-checked by FastAPI) a 400."""
    try:
        return fn(*args)
    except personal.PersonalDataError as error:
        raise HTTPException(status_code=502, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.get("/api/personal/weather")
def personal_weather(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    units: str = "metric",
):
    """Current conditions + a 5-day forecast for a point (Open-Meteo,
    cached server-side). The location itself is a per-browser preference,
    so it comes in on every call rather than being stored here."""
    return _personal(personal.get_weather, lat, lon, units)


@router.get("/api/personal/places")
def personal_places(q: str = Query(min_length=2, max_length=80)):
    """City search for picking a weather location."""
    return {"places": _personal(personal.search_places, q)}


@router.get("/api/personal/word")
def personal_word():
    """Today's Wiktionary word of the day."""
    return _personal(personal.get_word_of_the_day)


@router.get("/api/notes")
def list_notes():
    """Personal-tab notes, newest edit first."""
    return {"notes": notes.all()}


@router.post("/api/notes", status_code=201)
def create_note(payload: dict | None = None):
    try:
        return notes.create((payload or {}).get("body", ""))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.put("/api/notes/{note_id}")
def save_note(note_id: str, payload: dict):
    """Save one note. ``base_updated_at`` is the version being edited; if it
    has since changed (another device), this answers 409 with the current
    copy instead of overwriting it."""
    base = payload.get("base_updated_at")
    if base is not None and (isinstance(base, bool) or not isinstance(base, (int, float))):
        raise HTTPException(status_code=400, detail="'base_updated_at' must be a number")
    try:
        note = notes.update(note_id, payload.get("body"), base)
    except Conflict as conflict:
        return JSONResponse(
            status_code=409,
            content={"detail": "This note was changed somewhere else.", "current": conflict.current},
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if note is None:
        raise HTTPException(status_code=404, detail="no such note")
    return note


@router.delete("/api/notes/{note_id}")
def delete_note(note_id: str):
    if not notes.delete(note_id):
        raise HTTPException(status_code=404, detail="no such note")
    return {"deleted": note_id}


@router.get("/api/todos")
def list_todos():
    """The to-do list (Personal tab). Shared across browsers; also in every /ws tick."""
    return {"todos": todos.all()}


@router.put("/api/todos")
def set_todos(payload: dict):
    items = payload.get("todos")
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="'todos' must be a list")
    return {"todos": todos.replace(items)}


@router.get("/api/audit")
def list_audit(limit: int = Query(200, ge=1, le=1000), before: float | None = None, q: str | None = None):
    """Who did what, newest first — see audit_log.py. ``before`` pages back;
    ``q`` filters on any text in an entry."""
    return {"entries": audit_log.read(limit, before, q)}


@router.get("/api/notify")
def notify_settings():
    """Phone notifications (ntfy): server, topic, how serious an alert must
    be. The topic is shown so a phone can subscribe to it."""
    return notify.settings()


@router.put("/api/notify")
def set_notify(payload: dict, request: Request, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    origin = request.headers.get("origin")
    try:
        return notify.update(payload, dashboard_url=origin)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.post("/api/notify/test")
def test_notify(x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    if not notify.settings()["topic"]:
        raise HTTPException(status_code=400, detail="turn notifications on first")
    ok = notify.send("Homelab test", "Notifications from your dashboard reach this phone.",
                     priority=3, tags=["tada"], force=True)
    if not ok:
        raise HTTPException(status_code=502, detail="the ntfy server didn't accept it — check the address")
    return {"sent": True}


@router.get("/api/history/settings")
def get_history_settings():
    """How long the audit log and the activity history are kept."""
    return {**history_settings.get(), "choices": history_settings.CHOICES}


@router.put("/api/history/settings")
def set_history_settings(payload: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    try:
        settings = history_settings.update(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    audit_log.prune()
    return {**settings, "choices": history_settings.CHOICES}
