// The Overview to-do list lives on the backend (GET/PUT /api/todos) and
// rides the WebSocket payload, so it's the same on every browser.
// localStorage keeps a copy only so the first paint after a reload — before
// the first WS tick — shows the list instead of flashing empty.
//
// Mirrors containerPins.js; items here are objects
// ({ id, text, done, created_at }) rather than strings.

const CACHE_KEY = "homelab.todos";

export function loadCachedTodos() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cacheTodos(items) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

export async function putTodos(items) {
  const response = await fetch("/api/todos", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ todos: items }),
  });
  if (!response.ok) throw new Error(`PUT /api/todos failed: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.todos) ? body.todos : items;
}
