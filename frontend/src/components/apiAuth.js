// Shared by the API wrappers that hit token-protected routes. The token, when
// the backend requires one, is read from sessionStorage (entered in a
// TokenBox) and sent as X-Register-Token.

export function authHeaders() {
  const token = sessionStorage.getItem("apiToken");
  return token ? { "X-Register-Token": token } : {};
}

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
