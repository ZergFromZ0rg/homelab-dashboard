import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import GitUpdates from "../GitUpdates";
import { confirmedFetch } from "../confirmedFetch";

vi.mock("../confirmedFetch", () => ({ confirmedFetch: vi.fn() }));

const project = (changes = {}) => ({
  id: "project-a", project: "dashboard", repository: "https://github.com/home/dashboard",
  working_dir: "/srv/dashboard", branch: "main", containers: ["frontend", "backend"],
  enabled: false, state: "disabled", can_enable: true, reason: null, ...changes,
});
const listing = (projects = [project()], changes = {}) => ({
  hosts: [{ host: "home server", available: true, enabled: true, poll_seconds: 15, projects, ...changes }],
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const open = () => fireEvent.click(screen.getByRole("button", { name: /Automatic updates/ }));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(listing())));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("discovers repositories only when opened and shows their host, branch, and timing", async () => {
  render(<GitUpdates demo={false} />);
  expect(fetch).not.toHaveBeenCalled();
  open();
  const toggle = await screen.findByRole("switch", { name: "Automatic updates for dashboard on home server" });
  expect(toggle.checked).toBe(false);
  expect(screen.getByText("main")).toBeTruthy();
  expect(screen.getByText("/srv/dashboard")).toBeTruthy();
  expect(screen.getByText(/every 15 seconds; rebuilding takes additional time/)).toBeTruthy();
  expect(screen.getByRole("link").href).toBe("https://github.com/home/dashboard");
  expect(fetch.mock.calls[0][0]).toBe("/api/git-updates");
});

test("saves the switch through step-up authentication and keeps server state when a save fails", async () => {
  confirmedFetch.mockResolvedValueOnce(response(project({ enabled: true, state: "watching" })));
  confirmedFetch.mockResolvedValueOnce(response({ detail: "Host is unreachable" }, 502));
  render(<GitUpdates demo={false} />);
  open();
  const toggle = await screen.findByRole("switch");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(confirmedFetch).toHaveBeenCalledWith("/api/git-updates/home%20server/project-a", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}',
  });
  expect(screen.getByText("Pending first check")).toBeTruthy();
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Host is unreachable");
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(false);
});

test("polls while open, aborts on close, and clears its timer on unmount", async () => {
  vi.useFakeTimers();
  const { unmount } = render(<GitUpdates demo={false} />);
  await act(async () => { open(); });
  expect(fetch).toHaveBeenCalledTimes(1);
  const signal = fetch.mock.calls[0][1].signal;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  open();
  expect(signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { open(); });
  expect(fetch).toHaveBeenCalledTimes(3);
  const reopenedSignal = fetch.mock.calls[2][1].signal;
  unmount();
  expect(reopenedSignal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("a listing started before a successful save cannot revert the selected repository", async () => {
  vi.useFakeTimers();
  const olderRead = deferred();
  fetch.mockResolvedValueOnce(response(listing())).mockReturnValueOnce(olderRead.promise);
  confirmedFetch.mockResolvedValueOnce(response(project({ enabled: true, state: "watching" })));
  render(<GitUpdates demo={false} />);
  await act(async () => { open(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => { fireEvent.click(screen.getByRole("switch")); });
  expect(screen.getByRole("switch").checked).toBe(true);
  await act(async () => { olderRead.resolve(response(listing())); });
  expect(screen.getByRole("switch").checked).toBe(true);
});

test("blocked repositories show their reason but can still be turned off", async () => {
  fetch.mockResolvedValue(response(listing([
    project({ can_enable: false, reason: "REBUILD_ENABLED is disabled" }),
    project({ id: "project-b", project: "media", enabled: true, state: "blocked", can_enable: false, reason: "Local changes must be committed" }),
  ])));
  confirmedFetch.mockResolvedValueOnce(response(project({ id: "project-b", project: "media", enabled: false, can_enable: false })));
  render(<GitUpdates demo={false} />);
  open();
  const toggles = await screen.findAllByRole("switch");
  expect(toggles[0].disabled).toBe(true);
  expect(toggles[1].disabled).toBe(false);
  expect(screen.getByText("REBUILD_ENABLED is disabled")).toBeTruthy();
  fireEvent.click(toggles[1]);
  await waitFor(() => expect(toggles[1].checked).toBe(false));
});

test("unsupported agents and empty hosts explain how repositories are discovered", async () => {
  fetch.mockResolvedValue(response({ hosts: [
    { host: "older host", available: false, status_code: 404, projects: [] },
    { host: "new host", available: true, enabled: true, projects: [] },
  ] }));
  render(<GitUpdates demo={false} />);
  open();
  expect(await screen.findByText(/This agent does not support automatic updates yet/)).toBeTruthy();
  expect(screen.getByText(/No repositories found. Run a Docker Compose project from a cloned Git repository/)).toBeTruthy();
});

test("unsafe remote URLs render as text without a clickable link", async () => {
  fetch.mockResolvedValue(response(listing([project({ repository: "javascript:alert(1)" })])));
  render(<GitUpdates demo={false} />);
  open();
  expect(await screen.findByText("javascript:alert(1)")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("demo mode shows sample repositories without any network or write access", async () => {
  render(<GitUpdates demo />);
  open();
  const toggle = screen.getByRole("switch");
  expect(toggle.disabled).toBe(true);
  expect(screen.getByText("Demo preview — switches are read-only.")).toBeTruthy();
  fireEvent.click(toggle);
  expect(fetch).not.toHaveBeenCalled();
  expect(confirmedFetch).not.toHaveBeenCalled();
});

test("refresh failures keep the last status visible and prevent stale settings edits", async () => {
  vi.useFakeTimers();
  fetch.mockResolvedValueOnce(response(listing())).mockRejectedValueOnce(new Error("Connection lost"));
  render(<GitUpdates demo={false} />);
  await act(async () => { open(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("alert").textContent).toContain("Connection lost");
  expect(screen.getByRole("switch").disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("switch").disabled).toBe(false);
});
