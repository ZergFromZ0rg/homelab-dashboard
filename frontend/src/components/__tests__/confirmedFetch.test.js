// Root-level actions: a 403 {elevate} shows the passkey sheet once, then
// retries; anything else passes straight through.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../passkeyApi", () => ({
  confirmWithPasskey: vi.fn(() => Promise.resolve({ elevated_until: 1 })),
  getAuthStatus: vi.fn(),
}));

import { confirmWithPasskey, getAuthStatus } from "../passkeyApi";
import { confirmedFetch, ensureConfirmed } from "../confirmedFetch";

const json = (status, body) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  globalThis.fetch = vi.fn();
  confirmWithPasskey.mockClear();
});
afterEach(() => vi.restoreAllMocks());

test("asks for the passkey and retries once", async () => {
  fetch
    .mockResolvedValueOnce(json(403, { detail: { elevate: true, message: "confirm" } }))
    .mockResolvedValueOnce(json(200, { ok: true }));
  const res = await confirmedFetch("/api/disk/box/delete", { method: "POST" });
  expect(res.status).toBe(200);
  expect(confirmWithPasskey).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("a plain 403 is not a reason to prompt", async () => {
  fetch.mockResolvedValueOnce(json(403, { detail: "no" }));
  const res = await confirmedFetch("/x");
  expect(res.status).toBe(403);
  expect(confirmWithPasskey).not.toHaveBeenCalled();
});

test("dismissing the sheet means the action doesn't happen", async () => {
  fetch.mockResolvedValueOnce(json(403, { detail: { elevate: true } }));
  confirmWithPasskey.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
  await expect(confirmedFetch("/x", { method: "POST" })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a still-fresh confirmation isn't asked for again", async () => {
  getAuthStatus.mockResolvedValueOnce({ enabled: true, elevated_until: Date.now() / 1000 + 300 });
  await ensureConfirmed();
  expect(confirmWithPasskey).not.toHaveBeenCalled();
  getAuthStatus.mockResolvedValueOnce({ enabled: true, elevated_until: null });
  await ensureConfirmed();
  expect(confirmWithPasskey).toHaveBeenCalledTimes(1);
});
