// The device list: look-only rows don't open a panel; in God they do.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../DeviceDetail", () => ({ default: ({ row }) => <aside aria-label={`Details for ${row.name}`} /> }));
vi.mock("../piholeApi", async (original) => ({ ...(await original()), fetchDevices: vi.fn() }));

import DeviceTable from "../DeviceTable";
import { fetchDevices } from "../piholeApi";

beforeEach(() => {
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

test("clicking a row opens its panel in God", async () => {
  render(<DeviceTable />);
  fireEvent.click(await screen.findByText("bigboy"));
  expect(await screen.findByLabelText("Details for bigboy")).toBeTruthy();
});

test("clicking a row does nothing when look-only", async () => {
  render(<DeviceTable readOnly />);
  const row = (await screen.findByText("bigboy")).closest("tr");
  fireEvent.click(row);
  expect(screen.queryByLabelText("Details for bigboy")).toBeNull();
  expect(row.className).toContain("dev-row--static");
  expect(row.getAttribute("aria-selected")).toBeNull();
});
