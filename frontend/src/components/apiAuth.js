// Shared by the API wrappers that hit token-protected routes. The token, when
// the backend requires one, is read from sessionStorage (entered in a
// TokenBox) and sent as X-Register-Token.

export function authHeaders() {
  const token = sessionStorage.getItem("apiToken");
  return token ? { "X-Register-Token": token } : {};
}

export async function jsonOrThrow(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || body.error || `Request failed: ${response.status}`);
  }
  return body;
}
