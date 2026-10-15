// The Containers card on Simple: a list of what you read it for, with actions.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SimpleContainers from "../SimpleContainers";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const stats = (cpu, used, limit, rx, tx) => ({
  cpu_percent: cpu,
  memory: { used_bytes: used, limit_bytes: limit },
  network: { rx_bps: rx, tx_bps: tx },
});

const containers = {
  bigboy: [
    { id: "a1", name: "jellyfin", image: "jellyfin/jellyfin", status: "running", health: "healthy", started_at: "2026-10-10T00:00:00Z", stats: stats(12.34, 1.5 * 1024 ** 3, 4 * 1024 ** 3, 2048, 512) },
    { id: "b2", name: "radarr", image: "x/radarr", status: "exited", stats: stats(0, 0, 0, 0, 0) },
    { id: "c3", name: "plex", image: "x/plex", status: "running", health: "unhealthy", stats: stats(1, 1024 ** 2, 0, 0, 0) },
  ],
};

const control = () => ({ run: vi.fn(), pending: {}, errors: {} });

function show(over = {}) {
  const onControl = over.onControl ?? control();
  render(<SimpleContainers containers={containers} pins={[]} onControl={onControl} {...over} />);
  return onControl;
}

test("a row gives state, CPU, memory, network and uptime", () => {
  show();
  const row = screen.getByText("jellyfin").closest("tr");
  const cells = within(row);
  expect(cells.getByText("running")).toBeTruthy();
  expect(cells.getByText("12.3%")).toBeTruthy();
  expect(cells.getByText("1.5 GB")).toBeTruthy();
  expect(row.textContent).toContain("2 KB/s");
  expect(row.textContent).toContain("512 B/s");
});

test("stopped containers come first, and say nothing about load", () => {
  show();
  const names = [...document.querySelectorAll(".sh-table tbody tr")].map((r) => r.querySelector(".sh-name").lastElementChild.textContent);
  expect(names).toEqual(["radarr", "jellyfin", "plex"]);
  const row = screen.getByText("radarr").closest("tr");
  expect(row.querySelector(".sh-meter")).toBeNull();
  expect(within(row).getByText("exited")).toBeTruthy();
});

test("only a health state that needs attention is written out", () => {
  show();
  expect(within(screen.getByText("jellyfin").closest("tr")).queryByText("healthy")).toBeNull();
  expect(within(screen.getByText("plex").closest("tr")).getByText("unhealthy")).toBeTruthy();
});

test("stop asks first, then goes through onControl", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const onControl = show();
  fireEvent.click(within(screen.getByText("jellyfin").closest("tr")).getByLabelText("Stop"));
  expect(confirm).toHaveBeenCalledWith("Stop jellyfin on bigboy?");
  expect(onControl.run).toHaveBeenCalledWith("bigboy", "a1", "stop");
});

test("declining the question does nothing", () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const onControl = show();
  fireEvent.click(within(screen.getByText("radarr").closest("tr")).getByLabelText("Start"));
  expect(onControl.run).not.toHaveBeenCalled();
});

test("restart is on every row", () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onControl = show();
  fireEvent.click(within(screen.getByText("radarr").closest("tr")).getByLabelText("Restart"));
  expect(onControl.run).toHaveBeenCalledWith("bigboy", "b2", "restart");
});

test("a container being stopped says so", () => {
  show({ onControl: { run: vi.fn(), pending: { "bigboy-a1": "stop" }, errors: {} } });
  expect(within(screen.getByText("jellyfin").closest("tr")).getByText("stop…")).toBeTruthy();
});

test("the filter narrows the list by name or host", () => {
  show();
  fireEvent.change(screen.getByLabelText("Find a container"), { target: { value: "rad" } });
  expect(screen.queryByText("jellyfin")).toBeNull();
  expect(screen.getByText("radarr")).toBeTruthy();
});

test("tiles are the other view, and the choice is kept", () => {
  show();
  fireEvent.click(screen.getByLabelText("Tiles"));
  expect(document.querySelector(".sh-apps-grid")).toBeTruthy();
  expect(document.querySelector(".sh-table")).toBeNull();
  expect(JSON.parse(localStorage.getItem("homelab.simpleContainers"))).toBe("tiles");
});

test("the tile view leaves out what is pinned above", () => {
  show({ pins: ["bigboy/jellyfin"] });
  fireEvent.click(screen.getByLabelText("Tiles"));
  const names = [...document.querySelectorAll(".sh-apps-grid .sh-app-name")].map((n) => n.textContent);
  expect(names).not.toContain("jellyfin");
  expect(names).toContain("radarr");
});
