// The checklist only counts what it could confirm, and leaves when done.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../passkeyApi", () => ({ getAuthStatus: vi.fn() }));
import { getAuthStatus } from "../passkeyApi";
import FirstRun from "../FirstRun";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("an unknown step isn't counted as done", async () => {
  getAuthStatus.mockRejectedValueOnce(new Error("offline"));
  render(<FirstRun machines={{}} backups={null} onNavigate={vi.fn()} />);
  expect(await screen.findByText("0/4")).toBeTruthy();
  expect(screen.queryByText(/Add a passkey/)).toBeNull();
});

test("gone once everything is done", async () => {
  getAuthStatus.mockResolvedValueOnce({ enabled: true });
  const machines = { a: { cpu: 3, agent_reachable: true }, b: { cpu: 5, agent_reachable: true } };
  const { container } = render(<FirstRun machines={machines} backups={{ total: 1 }} onNavigate={vi.fn()} />);
  await vi.waitFor(() => expect(getAuthStatus).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
