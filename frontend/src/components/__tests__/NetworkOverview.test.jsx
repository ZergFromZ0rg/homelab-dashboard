// The Network overview: every panel says what it has, and one source being
// down, unconfigured or slow never blanks the window.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NetworkOverview from "../NetworkOverview";
import { fetchBandwidth } from "../bandwidthApi";
import { fetchMatrix } from "../checksApi";
import { fetchDevices, fetchPihole } from "../piholeApi";
import { fetchSpeedtest } from "../speedtestApi";
import { fetchSwitch } from "../switchApi";

vi.mock("../bandwidthApi", async (original) => ({ ...(await original()), fetchBandwidth: vi.fn() }));
vi.mock("../checksApi", async (original) => ({ ...(await original()), fetchMatrix: vi.fn() }));
vi.mock("../piholeApi", async (original) => ({ ...(await original()), fetchPihole: vi.fn(), fetchDevices: vi.fn() }));
vi.mock("../speedtestApi", async (original) => ({ ...(await original()), fetchSpeedtest: vi.fn() }));
vi.mock("../switchApi", async (original) => ({ ...(await original()), fetchSwitch: vi.fn() }));

const now = Date.now() / 1000;

const speed = {
  every_hours: 6,
  running: false,
  error: null,
  link_mbps: 100,
  results: [{ at: now - 3600, down_mbps: 94, up_mbps: 10.4, ping_ms: 15, jitter_ms: 2.5, busy: false }],
};

const trend = (v) => Array.from({ length: 12 }, (_, i) => ({ t: now - (12 - i) * 60, v: v + i }));
const bandwidth = {
  state: "up",
  totals_window: "24h",
  devices: [
    { index: 0, name: "Internet", uplink: true, wan: true, up: true, down_bps: 21e6, up_bps: 4e6, down_24h: 60e9, up_24h: 9e9, down_trend: trend(18e6), up_trend: trend(3e6) },
    { index: 2, name: "bigboy", up: true, down_bps: 2e6, up_bps: 38e6, down_24h: 14e9, up_24h: 205e9, down_trend: [], up_trend: [] },
    { index: 10000, name: "Not on the switch", derived: true, up: true, down_bps: 18e6, up_bps: null, down_24h: 41e9, up_24h: null, down_trend: [], up_trend: [] },
  ],
};

const pihole = {
  configured: true,
  reachable: true,
  stale: false,
  error: null,
  summary: { total: 4315, blocked: 363, percent_blocked: 8.4, active_clients: 17, gravity_domains: 72526 },
  blocking: { enabled: true, state: "enabled", timer: null },
  health: {},
  updated_at: now,
};

const devices = { devices: [{ mac: "44:d5", name: "amazon-9e28", kind: "unknown", new: true }], kinds: [], groups: [] };

const port = (index, name, over = {}) => ({
  index,
  name,
  port: `g${index}`,
  labelled: true,
  up: true,
  speed_mbps: 1000,
  usual_speed_mbps: 1000,
  received_bps: 2e6,
  sent_bps: 1e6,
  errors_24h: 0,
  ...over,
});
const sw = { state: "up", instance: "192.168.1.2", ports: [port(1, "router", { speed_mbps: 100, usual_speed_mbps: 100 }), port(5, "pi-hole", { up: false, speed_mbps: null })] };

const matrix = {
  hosts: ["bigboy", "thinkpad"],
  cells: [{ from: "bigboy", to: "thinkpad", id: "m1", status: "up", latency_ms: 0.9, loss_pct_3h: 0, jitter_ms_3h: 0.2, p95_ms_24h: 2, uptime_24h: 100 }],
};

const check = (id, name, status, over = {}) => ({
  id,
  name,
  status,
  type: "http",
  target: `http://${name}`,
  latency_ms: 30,
  suppressed_by: null,
  recent: [],
  ...over,
});
const checks = [check("k1", "Jellyfin", "up"), check("k2", "Nextcloud", "down", { down_since: now - 600 })];

const everythingAnswers = () => {
  fetchSpeedtest.mockResolvedValue(speed);
  fetchBandwidth.mockResolvedValue(bandwidth);
  fetchPihole.mockResolvedValue(pihole);
  fetchDevices.mockResolvedValue(devices);
  fetchSwitch.mockResolvedValue(sw);
  fetchMatrix.mockResolvedValue(matrix);
};

const open = (props = {}) =>
  render(<NetworkOverview checks={checks} issues={[]} ready hosts={["bigboy", "thinkpad"]} onSection={vi.fn()} {...props} />);

const panel = (title) => screen.getByRole("heading", { name: title }).closest("section");

beforeEach(() => {
  for (const f of [fetchSpeedtest, fetchBandwidth, fetchPihole, fetchDevices, fetchSwitch, fetchMatrix]) f.mockReset();
});
afterEach(cleanup);

test("shows each panel with what its source says, and the headline numbers", async () => {
  everythingAnswers();
  open();

  expect(await screen.findByText("94.0")).toBeTruthy();
  expect(await within(panel("DNS")).findByText("4,315")).toBeTruthy();
  expect(await within(panel("Switch")).findByText("router")).toBeTruthy();
  expect(await within(panel("Who's using it")).findByText("bigboy")).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "Between hosts" })).toBeTruthy();

  // The strip: nothing is wrong, one of two checks answers, the switch has a port without a link.
  const strip = within(document.querySelector(".stat-strip"));
  expect(strip.getByText("all clear")).toBeTruthy();
  expect(strip.getByText("1/2")).toBeTruthy();
  expect(strip.getByText("1/2 up")).toBeTruthy();
  expect(strip.getByText("8.4% blocked")).toBeTruthy();
  // The Uptime panel puts the down check first, with how long it has been down.
  expect(within(panel("Uptime")).getByText("down 10m")).toBeTruthy();
  // Nothing needs attention, so the line for it is not there.
  expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
});

test("lists what is wrong, and each problem opens the page that explains it", async () => {
  everythingAnswers();
  const onSection = vi.fn();
  open({
    onSection,
    issues: [
      { key: "check:k2", severity: "bad", title: "Nextcloud is down", message: "" },
      { key: "network:new-devices", severity: "warn", title: "1 new device on the network", message: "" },
    ],
  });

  const list = screen.getByRole("list", { name: "Needs attention" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("2 issues")).toBeTruthy();

  fireEvent.click(within(list).getByText("Nextcloud is down"));
  expect(onSection).toHaveBeenCalledWith("checks/k2");
  fireEvent.click(within(list).getByText("1 new device on the network"));
  expect(onSection).toHaveBeenCalledWith("dns");
  await screen.findByText("94.0");
});

test("a panel's link opens its tool", async () => {
  everythingAnswers();
  const onSection = vi.fn();
  open({ onSection });
  await screen.findByText("94.0");

  fireEvent.click(within(panel("Uptime")).getByRole("button", { name: /Open/ }));
  expect(onSection).toHaveBeenCalledWith("checks");
  fireEvent.click(within(panel("DNS")).getByRole("button", { name: /Devices/ }));
  expect(onSection).toHaveBeenCalledWith("dns");
  fireEvent.click(within(panel("Internet")).getByRole("button", { name: /Bandwidth/ }));
  expect(onSection).toHaveBeenCalledWith("bandwidth");
});

test("says so, in one line, when Pi-hole and the switch are not connected", async () => {
  everythingAnswers();
  fetchPihole.mockResolvedValue({ configured: false });
  fetchSwitch.mockResolvedValue({ state: "unconfigured", ports: [] });
  open();

  expect(await within(panel("DNS")).findByText(/Pi-hole isn't connected/)).toBeTruthy();
  expect(await within(panel("Switch")).findByText(/no job named/)).toBeTruthy();
  // The rest of the window is untouched, and no zeros stand in for the missing numbers.
  expect(await screen.findByText("94.0")).toBeTruthy();
  expect(screen.queryByText(/blocked/)).toBeNull();
});

test("one source failing leaves the other panels alone", async () => {
  everythingAnswers();
  fetchPihole.mockRejectedValue(new Error("nope"));
  fetchDevices.mockRejectedValue(new Error("nope"));
  fetchSwitch.mockRejectedValue(new Error("nope"));
  open();

  expect(await within(panel("DNS")).findByText(/Couldn't ask the dashboard about Pi-hole/)).toBeTruthy();
  expect(await within(panel("Switch")).findByText(/Couldn't ask the dashboard about the switch/)).toBeTruthy();
  expect(await screen.findByText("94.0")).toBeTruthy();
  expect(within(panel("Uptime")).getByText("Jellyfin")).toBeTruthy();
});

test("says it is loading before the answers arrive, and has no Between hosts without pairs", async () => {
  for (const f of [fetchSpeedtest, fetchBandwidth, fetchPihole, fetchDevices, fetchSwitch]) f.mockReturnValue(new Promise(() => {}));
  fetchMatrix.mockResolvedValue({ hosts: [], cells: [] });
  open({ ready: false, checks: [] });

  expect(within(panel("DNS")).getByText("Loading…")).toBeTruthy();
  expect(within(panel("Internet")).getByText("Loading…")).toBeTruthy();
  // Before the first update nothing claims the network is fine.
  expect(screen.queryByText("all clear")).toBeNull();
  expect(within(panel("Uptime")).getByText(/No checks yet/)).toBeTruthy();
  await vi.waitFor(() => expect(fetchMatrix).toHaveBeenCalled());
  expect(screen.queryByRole("heading", { name: "Between hosts" })).toBeNull();
});
