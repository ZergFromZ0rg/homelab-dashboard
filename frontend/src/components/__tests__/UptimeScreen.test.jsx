// The Uptime screen: a list of checks, the one you pick beside it, and a pane
// that is never empty.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import UptimeScreen from "../UptimeScreen";
import { fetchCheckHistory, fetchIncidents, fetchSuggestions } from "../checksApi";

vi.mock("../checksApi", async (original) => ({
  ...(await original()),
  fetchCheckHistory: vi.fn(),
  fetchIncidents: vi.fn(),
  fetchSuggestions: vi.fn(),
}));

const now = Date.now() / 1000;

const check = (id, name, status, over = {}) => ({
  id,
  name,
  status,
  type: "http",
  target: `http://${name.toLowerCase()}`,
  group: null,
  parent: null,
  suppressed_by: null,
  latency_ms: 30,
  recent: [30, 31, 29],
  uptime_24h: 100,
  uptime_7d: 100,
  uptime_30d: 100,
  p50_ms_24h: 30,
  p95_ms_24h: 60,
  checked_at: now - 5,
  ...over,
});

const checks = [
  check("k1", "Jellyfin", "up", { group: "bigboy" }),
  check("k2", "Grafana", "degraded", { group: "bigboy", latency_ms: 89, slow_ms: 80, uptime_24h: 99.5 }),
  check("k5", "Nextcloud", "down", { group: "Cloud", down_since: now - 1080, detail: "HTTP 502", latency_ms: null, uptime_24h: 93.4 }),
  check("k6", "Nextcloud DB", "down", { group: "Cloud", parent: "k5", suppressed_by: { id: "k5", name: "Nextcloud" }, latency_ms: null }),
  check("k7", "Plex", "paused", { group: "bigboy", paused: true }),
];

const history = { range: "24h", bucket_seconds: 600, uptime: 99, p50: 30, p95: 60, loss: null, jitter: null, points: [], incidents: [] };

beforeEach(() => {
  fetchSuggestions.mockReset().mockResolvedValue({ suggestions: [] });
  fetchCheckHistory.mockReset().mockResolvedValue(history);
  fetchIncidents.mockReset().mockResolvedValue({ incidents: [] });
});
afterEach(cleanup);

const open = (props = {}) => render(<UptimeScreen checks={checks} connected hosts={["bigboy"]} {...props} />);
const detail = () => within(screen.getByRole("complementary", { name: "Check detail" }));
const rows = () => [...document.querySelectorAll(".up-row")].map((r) => r.querySelector("strong").textContent);

test("opens on the worst check, so the pane is never empty", async () => {
  open();
  expect(detail().getByRole("heading", { name: "Nextcloud" })).toBeTruthy();
  expect(detail().getByText("Down")).toBeTruthy();
  expect(detail().getByRole("button", { name: "Check now" })).toBeTruthy();
  expect(detail().getByRole("button", { name: "Delete" })).toBeTruthy();
  await vi.waitFor(() => expect(fetchCheckHistory).toHaveBeenCalledWith("k5", "24h"));
});

test("lists the checks by group, worst first, and shows the one you click", () => {
  open();
  expect(rows()).toEqual(["Nextcloud", "Nextcloud DB", "Grafana", "Jellyfin", "Plex"]);

  fireEvent.click(within(document.querySelector(".up-scroll")).getByText("Jellyfin"));
  expect(detail().getByRole("heading", { name: "Jellyfin" })).toBeTruthy();
  expect(document.querySelector(".up-row.is-selected strong").textContent).toBe("Jellyfin");
});

test("opens on the check a link named", () => {
  open({ initialId: "k2" });
  expect(detail().getByRole("heading", { name: "Grafana" })).toBeTruthy();
});

test("the filters narrow the list and count the root causes, not what is behind them", () => {
  open();
  const down = screen.getByRole("button", { name: /^Down/ });
  expect(down.textContent).toContain("1");

  fireEvent.click(down);
  expect(rows()).toEqual(["Nextcloud", "Nextcloud DB"]);

  fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
  expect(rows()).toEqual(["Plex"]);

  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter checks" }), { target: { value: "graf" } });
  expect(rows()).toEqual(["Grafana"]);

  fireEvent.change(screen.getByRole("searchbox", { name: "Filter checks" }), { target: { value: "zzz" } });
  expect(screen.getByText(/No checks match/)).toBeTruthy();
});

test("adding a check opens the form in the pane, and cancelling puts the check back", () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: "+ Add check" }));
  expect(detail().getByRole("heading", { name: "Add a check" })).toBeTruthy();
  expect(rows()).toHaveLength(5); // the list did not move

  fireEvent.click(detail().getByRole("button", { name: "Cancel" }));
  expect(detail().getByRole("heading", { name: "Nextcloud" })).toBeTruthy();
});

test("editing opens the form for that check", () => {
  open({ initialId: "k1" });
  fireEvent.click(detail().getByRole("button", { name: "Edit" }));
  expect(detail().getByRole("heading", { name: "Edit Jellyfin" })).toBeTruthy();
  expect(detail().getByDisplayValue("Jellyfin")).toBeTruthy();
});

test("what nothing watches yet is a count beside the filters and a list in the pane", async () => {
  fetchSuggestions.mockResolvedValue({
    suggestions: [{ key: "host:bigboy", group: "Hosts", name: "bigboy", type: "ping", target: "192.168.1.10", reason: "is this machine reachable" }],
  });
  open();

  const chip = await screen.findByRole("button", { name: /not monitored/ });
  expect(chip.textContent).toContain("1");
  fireEvent.click(chip);
  expect(detail().getByRole("heading", { name: "Not monitored yet" })).toBeTruthy();
  expect(detail().getByText("bigboy")).toBeTruthy();
  expect(detail().getByRole("button", { name: "Add 1 check" })).toBeTruthy();
});

test("the week's downtime is a pane of its own", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: /Incidents/ }));
  expect(detail().getByRole("heading", { name: "Downtime, last 7 days" })).toBeTruthy();
  expect(await detail().findByText(/No downtime in the last 7 days/)).toBeTruthy();
});

test("with no checks it says how to start, and the pane says what it will show", () => {
  open({ checks: [] });
  expect(screen.getByText(/No checks yet/)).toBeTruthy();
  expect(detail().getByText(/Add a check to see its history here/)).toBeTruthy();
});
