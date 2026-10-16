// The GitHub repos behind a host's containers, and the button that pulls and redeploys them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../rebuildApi", () => ({ startRebuild: vi.fn(), fetchRebuildJob: vi.fn() }));
import { fetchRebuildJob, startRebuild } from "../rebuildApi";
import RepoStrip from "../RepoStrip";

const repo = (over = {}) => ({
  owner: "ZergFromZ0rg", name: "ai-librarian", url: "https://github.com/ZergFromZ0rg/ai-librarian", branch: "main",
  short: "f4ef1c4", remote_short: "22ee733", state: "behind", subject: "Add the ledger", dirty: false, ...over,
});
const container = (name, over = {}) => ({
  id: `id-${name}`, name, compose_project: "ai-librarian", repo: repo(), rebuild: { project: "ai-librarian", service: name, can_pull: true }, ...over,
});

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  startRebuild.mockReset();
  fetchRebuildJob.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a repo with news says so and offers Pull & redeploy", () => {
  render(<RepoStrip host="bigboy" containers={[container("ui"), container("db")]} />);
  expect(screen.getByText("ZergFromZ0rg/ai-librarian")).toBeTruthy();
  expect(screen.getByText("New commits on GitHub")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pull & redeploy" })).toBeTruthy();
  expect(screen.getByText(/2 containers/)).toBeTruthy();
});

test("links to what changed on GitHub", () => {
  render(<RepoStrip host="bigboy" containers={[container("ui")]} />);
  const link = screen.getByText(/f4ef1c4 → 22ee733/);
  expect(link.getAttribute("href")).toBe("https://github.com/ZergFromZ0rg/ai-librarian/compare/f4ef1c4...22ee733");
});

test("an up-to-date repo is quiet and the button is just Redeploy", () => {
  render(<RepoStrip host="bigboy" containers={[container("ui", { repo: repo({ state: "up_to_date" }) })]} />);
  expect(screen.getByText("Up to date")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Redeploy" })).toBeTruthy();
  expect(screen.queryByText(/→/)).toBeNull();
});

test("uncommitted changes on the host are called out", () => {
  render(<RepoStrip host="bigboy" containers={[container("ui", { repo: repo({ dirty: true }) })]} />);
  expect(screen.getByText("uncommitted changes")).toBeTruthy();
});

test("pressing the button asks, then starts the rebuild through the project's container", async () => {
  startRebuild.mockResolvedValue({ id: "job1", state: "done", steps: [] });
  render(<RepoStrip host="bigboy" containers={[container("ui"), container("db")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull & redeploy" }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(startRebuild).toHaveBeenCalledWith("bigboy", "id-db", { pull: true }));
  expect(await screen.findByText("rebuilt")).toBeTruthy();
});

test("declining does nothing", () => {
  window.confirm.mockReturnValue(false);
  render(<RepoStrip host="bigboy" containers={[container("ui")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull & redeploy" }));
  expect(startRebuild).not.toHaveBeenCalled();
});

test("a failed rebuild is shown, with the reason on hover", async () => {
  startRebuild.mockRejectedValue(new Error("that repo is private"));
  render(<RepoStrip host="bigboy" containers={[container("ui")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull & redeploy" }));
  const note = await screen.findByText("rebuild failed");
  expect(note.closest("[role=status]").getAttribute("title")).toBe("that repo is private");
});

test("a host that has rebuilds off shows the repo but no button", () => {
  render(<RepoStrip host="bigboy" containers={[container("ui", { rebuild: null })]} />);
  expect(screen.getByText("New commits on GitHub")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /redeploy/i })).toBeNull();
  expect(screen.getByText("rebuilds off")).toBeTruthy();
});

test("nothing at all for containers that came from no GitHub repo", () => {
  const { container: dom } = render(<RepoStrip host="bigboy" containers={[{ id: "x", name: "jellyfin", compose_project: "media" }]} />);
  expect(dom.textContent).toBe("");
});
