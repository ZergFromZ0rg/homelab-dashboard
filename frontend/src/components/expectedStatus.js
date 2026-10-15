// A start or stop is done once the agent says so, but the container list only
// shows it at the next poll — a few seconds later. Until then, show what the
// action just made true; the real state replaces it as soon as it arrives.

const EXPECTED = { start: "running", stop: "exited" };

// Long enough for the next poll or two, short enough that a change someone
// else makes straight afterwards isn't hidden.
const HOLD_MS = 8000;

export function expectedStatus(action) {
  return EXPECTED[action] ?? null;
}

// `containers` is {host: [container]}; `expected` is {"host-id": {status, at}}.
// Returns `containers` itself when nothing is overridden, so memoised
// children don't re-render for nothing.
export function withExpected(containers, expected, now = Date.now()) {
  if (Object.keys(expected).length === 0) return containers;
  let changed = false;
  const out = {};
  for (const [host, list] of Object.entries(containers)) {
    out[host] = list.map((c) => {
      const e = expected[`${host}-${c.id}`];
      if (!e || now - e.at > HOLD_MS || c.status === e.status) return c;
      changed = true;
      return { ...c, status: e.status };
    });
  }
  return changed ? out : containers;
}

// Drop what has gone stale.
export function pruneExpected(expected, now = Date.now()) {
  const kept = Object.entries(expected).filter(([, e]) => now - e.at <= HOLD_MS);
  return kept.length === Object.keys(expected).length ? expected : Object.fromEntries(kept);
}
