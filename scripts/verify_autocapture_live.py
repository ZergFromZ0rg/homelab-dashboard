#!/usr/bin/env python3
"""Prove auto-capture's restart rule on a real server process.

The rule: when the dashboard restarts, every check that was *already* down
"fires" again at the first alert cycle. That is a restart rediscovering an old
outage and must not trigger a capture. A check that goes down *after* the
restart is a real new failure and must, even a minute after the start.

Unit tests cover the decision. They cannot show the real alert loop reaching it
inside a real uvicorn process, which is what this does, without touching the
production instance or needing a login:

  - it starts a throwaway container of the real dashboard image, with its own
    empty data volume (so no passkeys, no real data) and a fake agent, on this
    host's loopback;
  - scenario A: a check that was down for an hour before the (re)start. After
    the start the alert fires; the capture must NOT be requested;
  - scenario B: a fresh instance whose check is up, then goes down. The capture
    MUST be requested, with the check's own address and port, and be saved as
    an auto capture.

Run it on the Docker host that runs the dashboard (it needs the built image):

    python3 scripts/verify_autocapture_live.py            # image: homelab-dashboard-dashboard-api
    python3 scripts/verify_autocapture_live.py --image NAME

Needs only the standard library and Docker. Exits non-zero if either scenario
misbehaves. The blanket "ignore the first N seconds" window is set to an hour
(AUTOCAPTURE_GRACE=3600) so that, if the *old* time-based rule were in force,
scenario B would visibly fail.
"""

from __future__ import annotations

import argparse
import http.server
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

DASH_PORT = 18000
AGENT_PORT = 18123
CONTAINER = "verify-autocapture"
CHECK_ID = "livecheck001"
CHECK_NAME = "Live test target"


# --- a fake agent ----------------------------------------------------------------------------

class FakeAgent:
    """Answers just enough of an agent: an empty container list (the alert loop
    polls it) and the capture routes, recording what it is asked."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence
                pass

            def _send(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _record(self, body=None):
                outer.requests.append({"method": self.command, "path": self.path.split("?")[0], "body": body, "at": time.time()})

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/containers":
                    return self._send(200, {"containers": [], "gpu": None, "updated_at": None, "host": "fake"})
                if path == "/capture":
                    self._record()
                    posted = next((r for r in reversed(outer.requests) if r["method"] == "POST"), None)
                    expr = ((posted or {}).get("body") or {}).get("filter", {}).get("expr")
                    packets = [{"n": i, "ts": time.time() + i / 100, "len": 60, "hex": "aabbccddeeff", "proto": "TCP",
                                "src": "192.168.0.10", "dst": "192.168.0.20", "l2": 14} for i in range(1, 4)]
                    return self._send(200, {
                        "state": "done", "iface": "eth0", "filter": {"expr": expr} if expr else {}, "payload": "none",
                        "promisc": False, "duration": 5, "started_at": time.time() - 5, "finished_at": time.time(),
                        "totals": {"pkts": 3, "bytes": 180}, "packets": packets, "last": 3, "flows": [], "series": [],
                        "protocols": {}, "unlisted": 0, "drops": 0, "issues": {}, "names": {}, "container": None, "error": None,
                    })
                return self._send(404, {})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                self._record(body)
                if self.path.split("?")[0] == "/capture":
                    return self._send(200, {"state": "capturing"})
                return self._send(404, {})

            def do_DELETE(self):
                self._record()
                self._send(200, {"state": "stopped"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", AGENT_PORT), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def captures_requested(self) -> list[dict]:
        return [r for r in self.requests if r["method"] == "POST" and r["path"] == "/capture"]

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# --- helpers -----------------------------------------------------------------------------------

def docker(*args: str, check: bool = True) -> str:
    done = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and done.returncode:
        raise SystemExit(f"docker {' '.join(args[:3])} failed: {done.stderr.strip()}")
    return done.stdout


def lan_address() -> str:
    """This host's address on its default route — not loopback, which a capture
    can't see and auto-capture rightly refuses."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    finally:
        probe.close()


def free_port() -> int:
    probe = socket.socket()
    probe.bind(("0.0.0.0", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def seed(directory: Path, address: str, port: int, *, down_for: float | None) -> None:
    """Files the instance reads at start. ``down_for``: how long the check had
    already been failing when the dashboard 'restarted' (None: no history)."""
    now = time.time()
    (directory / "nodes.json").write_text(json.dumps({"fake": {"url": f"http://127.0.0.1:{AGENT_PORT}", "last_seen": now, "first_seen": now}}))
    (directory / "checks.json").write_text(json.dumps([{
        "id": CHECK_ID, "name": CHECK_NAME, "type": "tcp", "target": f"{address}:{port}",
        "interval": 10, "timeout": 2, "origin": "fake",
    }]))
    (directory / "autocapture.json").write_text(json.dumps({"enabled": True, "duration": 5, "per_host_per_hour": 4, "keep": 5}))
    if down_for is not None:  # the history file a dashboard that had been running leaves behind
        (directory / "check_history.json").write_text(json.dumps({"checks": {CHECK_ID: {
            "samples": [[now - 30, 0, None, "connection refused"]], "buckets": {}, "hist": {}, "incidents": [],
            "streak": 5, "slow_streak": 0, "loss_streak": 0, "quality": [], "fail_since": now - down_for,
        }}}))


def start(image: str, directory: Path) -> float:
    docker("rm", "-f", CONTAINER, check=False)
    docker(
        "run", "-d", "--name", CONTAINER, "--network", "host", "-v", f"{directory}:/data",
        "-e", "NODES_FILE=/data/nodes.json", "-e", "CHECKS_FILE=/data/checks.json",
        "-e", "CHECK_HISTORY_FILE=/data/check_history.json", "-e", "AUTOCAPTURE_FILE=/data/autocapture.json",
        "-e", "CAPTURES_DIR=/data/captures",
        "-e", "ALERT_INTERVAL=2", "-e", "CHECK_FAILURES_BEFORE_DOWN=2", "-e", "AUTOCAPTURE_GRACE=3600",
        "-e", "PROMETHEUS_URL=http://127.0.0.1:9", "-e", "MAIN_HOST=fake",
        image, "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(DASH_PORT),
    )
    began = time.time()
    for _ in range(80):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{DASH_PORT}/api/checks", timeout=2).read()
            return began
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.5)
    raise SystemExit("the throwaway dashboard never came up:\n" + logs()[-2000:])


def check_summary() -> dict:
    body = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{DASH_PORT}/api/checks", timeout=3).read())
    return next(c for c in body["checks"] if c["id"] == CHECK_ID)


def wait_for(predicate, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:  # noqa: BLE001 - keep polling
            pass
        time.sleep(0.5)
    return False


def logs() -> str:
    """Everything the container logged. ``docker logs`` replays stdout and stderr
    on the matching streams, and the app logs to stderr."""
    done = subprocess.run(["docker", "logs", CONTAINER], capture_output=True, text=True)
    return done.stdout + done.stderr


def stop_and_clean(directory: Path, image: str) -> None:
    docker("stop", "-t", "3", CONTAINER, check=False)
    docker("rm", "-f", CONTAINER, check=False)
    # The container wrote as root; clear it the same way, then drop the directory.
    docker("run", "--rm", "-v", f"{directory}:/d", "--entrypoint", "sh", image, "-c", "rm -rf /d/* /d/.[!.]*", check=False)
    shutil.rmtree(directory, ignore_errors=True)


results: list[tuple[bool, str]] = []


def verdict(ok: bool, message: str) -> None:
    results.append((ok, message))
    print(f"  {'PASS' if ok else 'FAIL'}  {message}")


# --- the scenarios -------------------------------------------------------------------------------

def scenario_a(image: str, agent: FakeAgent, address: str) -> None:
    print("\nA. the check was already down for an hour before the dashboard (re)started")
    port = free_port()  # nothing listens: connection refused at once
    directory = Path(tempfile.mkdtemp(prefix="verify-autocapture-a-"))
    seed(directory, address, port, down_for=3600)
    before = len(agent.captures_requested())
    try:
        began = start(image, directory)
        verdict(wait_for(lambda: check_summary()["status"] == "down", 30), "the restored check is down at once, as the real history would leave it")
        summary = check_summary()
        verdict(summary["down_since"] is not None and summary["down_since"] < began - 3000,
                f"its outage start survived the restart (began {int(began - summary['down_since'])}s before the process did)")
        saw = wait_for(lambda: "auto-capture ignoring" in logs(), 30)
        verdict(saw, "the alert loop fired and auto-capture logged that it is ignoring a restart rediscovering the outage")
        time.sleep(6)  # a few more alert cycles: it must stay quiet
        verdict(len(agent.captures_requested()) == before, "no capture was requested from the agent")
        verdict(not list((directory / "captures").glob("*.meta.json")), "and none was saved")  # globbing a missing directory is empty
        for line in [l for l in logs().splitlines() if "auto-capture" in l][:2]:
            print("        log:", line.split("INFO", 1)[-1].strip()[:150])
    finally:
        stop_and_clean(directory, image)


def scenario_b(image: str, agent: FakeAgent, address: str) -> None:
    print("\nB. the check is up when the dashboard starts, then goes down a minute in")
    directory = Path(tempfile.mkdtemp(prefix="verify-autocapture-b-"))
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((address, 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    stop_accepting = threading.Event()

    def accept_forever():
        listener.settimeout(0.3)
        while not stop_accepting.is_set():
            try:
                conn, _ = listener.accept()
                conn.close()
            except OSError:
                pass

    threading.Thread(target=accept_forever, daemon=True).start()
    seed(directory, address, port, down_for=None)
    before = len(agent.captures_requested())
    try:
        began = start(image, directory)
        verdict(wait_for(lambda: check_summary()["status"] == "up", 40), "the check is up")
        stop_accepting.set()
        listener.close()  # the target dies
        went_down = wait_for(lambda: check_summary()["status"] == "down", 60)
        verdict(went_down, "the check goes down after the dashboard started")
        asked = wait_for(lambda: len(agent.captures_requested()) > before, 40)
        age = time.time() - began
        verdict(asked, f"the capture WAS requested, {age:.0f}s after the dashboard started "
                       f"(a blanket start-up window would have ignored it; this run sets one of an hour)")
        if asked:
            body = agent.captures_requested()[-1]["body"]
            verdict(body.get("filter", {}).get("expr") == f"host {address} and port {port}",
                    f"it asked for exactly that connection: {body.get('filter', {}).get('expr')!r}")
            verdict(body.get("payload") == "none" and body.get("promisc") is False and body.get("duration") == 5,
                    "headers only, not promiscuous, for the configured duration")
        saved = wait_for(lambda: list((directory / "captures").glob("*.meta.json")), 40)
        verdict(bool(saved), "the result was saved")
        if saved:
            meta = json.loads(next((directory / "captures").glob("*.meta.json")).read_text())
            verdict(meta.get("auto") is True and CHECK_NAME in meta.get("reason", "") and meta.get("trigger") == f"check:{CHECK_ID}",
                    f"…as an auto capture of this check: {meta['name']!r}")
        for line in [l for l in logs().splitlines() if "auto-capture" in l][:2]:
            print("        log:", line.split("INFO", 1)[-1].strip()[:150])
    finally:
        stop_accepting.set()
        try:
            listener.close()
        except OSError:
            pass
        stop_and_clean(directory, image)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--image", default="homelab-dashboard-dashboard-api")
    image = parser.parse_args().image
    if not docker("image", "inspect", image, check=False):
        raise SystemExit(f"no image called {image!r} here — run this on the host that builds the dashboard, or pass --image")
    address = lan_address()
    print(f"image {image}; check target on {address}; fake agent on 127.0.0.1:{AGENT_PORT}")
    agent = FakeAgent()
    try:
        scenario_a(image, agent, address)
        scenario_b(image, agent, address)
    finally:
        agent.stop()
        docker("rm", "-f", CONTAINER, check=False)
    failed = [m for ok, m in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
