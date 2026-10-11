// Advanced's Network tab is look-only: the same views, minus anything that changes something.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../LatencyMatrix", () => ({ default: () => <div>latency matrix</div> }));
vi.mock("../CheckSuggestions", () => ({ default: () => <div>suggestions</div> }));
vi.mock("../CheckIncidents", () => ({ default: () => null }));
vi.mock("../checksApi", () => ({
  createCheck: vi.fn(),
  updateCheck: vi.fn(),
  deleteCheck: vi.fn(),
  runCheck: vi.fn(),
}));
vi.mock("../DeviceDetail", () => ({ default: ({ row }) => <aside aria-label={`Details for ${row.name}`} /> }));
vi.mock("../DeviceTable", () => ({ default: ({ readOnly }) => <div>{readOnly ? "devices (look only)" : "devices (editable)"}</div> }));
vi.mock("../piholeApi", async (original) => ({
  ...(await original()),
  fetchPihole: vi.fn(),
  fetchDevices: vi.fn(),
}));

import ServicesTab from "../ServicesTab";
import PiholePanel from "../PiholePanel";
import { fetchDevices, fetchPihole } from "../piholeApi";

beforeEach(() => {
  fetchPihole.mockResolvedValue({
    configured: true,
    reachable: true,
    stale: false,
    updated_at: Date.now() / 1000,
    summary: { total: 100, blocked: 8, percent_blocked: 8, active_clients: 5, gravity_domains: 70000 },
    blocking: { enabled: true, state: "enabled", timer: null },
    health: { versions: {}, update_available: [] },
  });
  fetchDevices.mockResolvedValue({
    devices: [{ mac: "aa:bb", name: "bigboy", kind: "server", ip: "10.0.0.2", ip_type: "static-lease", online: true, ghost: "", group_ids: [0] }],
    kinds: ["server"],
    groups: [{ id: 0, name: "Default" }],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

const check = {
  id: "c1",
  name: "jellyfin",
  type: "http",
  target: "http://bigboy:8096",
  status: "up",
  paused: false,
  group: null,
  parent: null,
  uptime_24h: 100,
  uptime_7d: 100,
  uptime_30d: 100,
  latency_ms: 12,
  recent: [],
};

test("the checks view shows the answers but offers no way to change a check", () => {
  render(<ServicesTab checks={[check]} connected hosts={[]} essential />);
  expect(screen.getByText("jellyfin")).toBeTruthy();
  expect(screen.getByLabelText("Check now")).toBeTruthy();
  expect(screen.getByLabelText("Show history")).toBeTruthy();
  for (const label of ["Pause", "Edit", "Delete"]) expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.queryByText("+ Add check")).toBeNull();
  expect(screen.queryByText("latency matrix")).toBeNull();
  expect(screen.queryByText("suggestions")).toBeNull();
});

test("God's checks view keeps every control", () => {
  render(<ServicesTab checks={[check]} connected hosts={[]} />);
  for (const label of ["Check now", "Show history", "Pause", "Edit", "Delete"]) expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.getByText("+ Add check")).toBeTruthy();
  expect(screen.getByText("latency matrix")).toBeTruthy();
  expect(screen.getByText("suggestions")).toBeTruthy();
});

test("an empty checks view tells Advanced where checks are added", () => {
  render(<ServicesTab checks={[]} connected hosts={[]} essential />);
  expect(screen.getByText(/added in God mode/)).toBeTruthy();
});

test("the DNS panel hides the pause-blocking control when look-only", async () => {
  render(<PiholePanel readOnly />);
  expect(await screen.findByText("devices (look only)")).toBeTruthy();
  expect(screen.queryByText("Pause blocking")).toBeNull();
});

test("the DNS panel keeps pause blocking in God", async () => {
  render(<PiholePanel />);
  expect(await screen.findByText("devices (editable)")).toBeTruthy();
  expect(screen.getByText("Pause blocking")).toBeTruthy();
});
