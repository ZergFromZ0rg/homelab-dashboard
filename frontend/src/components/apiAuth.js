// Requests ride the passkey session cookie. The old API-token box (and
// the X-Register-Token header it fed) is gone: a signed-in session
// satisfies API_TOKEN on the server, and the token is for scripts.

// Any 401 fires this; the auth gate listens and swaps in the sign-in screen
// instead of leaving a page of failing cards.
export const AUTH_REQUIRED_EVENT = "homelab:auth-required";

export async function jsonOrThrow(response) {
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!response.ok) {
    throw new Error(body.detail || body.error || `Request failed: ${response.status}`);
  }
  return body;
}
