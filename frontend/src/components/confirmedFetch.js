import { confirmWithPasskey, getAuthStatus } from "./passkeyApi";

// fetch() for the actions that are root on a host. The server answers 403
// {detail: {elevate: true}} when the session hasn't confirmed with its
// passkey in the last few minutes; this shows the Face ID / Touch ID sheet
// and sends the request again. Dismissing the sheet rejects, so the action
// simply doesn't happen.

let inFlight = null;

// One sheet at a time, however many requests asked for it.
function confirmOnce() {
  if (!inFlight) inFlight = confirmWithPasskey().finally(() => (inFlight = null));
  return inFlight;
}

async function wantsConfirmation(response) {
  if (response.status !== 403) return false;
  const body = await response.clone().json().catch(() => ({}));
  return Boolean(body?.detail?.elevate);
}

export async function confirmedFetch(url, init) {
  const response = await fetch(url, init);
  if (!(await wantsConfirmation(response))) return response;
  await confirmOnce();
  return fetch(url, init);
}

// Before something that can't be retried the same way (opening a host
// shell over a websocket): confirm first unless it's still fresh.
export async function ensureConfirmed() {
  const status = await getAuthStatus().catch(() => null);
  if (!status?.enabled || !status.step_up) return;
  if (status.elevated_until && status.elevated_until * 1000 > Date.now() + 5000) return;
  await confirmOnce();
}
