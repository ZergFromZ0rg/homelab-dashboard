// Shared X-Register-Token attachment for the routes that require
// API_TOKEN when the backend sets one — same sessionStorage key the
// Deploy tab's token box writes.
export function authHeaders() {
  const token = sessionStorage.getItem("apiToken");
  return token ? { "X-Register-Token": token } : {};
}
