// The Backups tab: the jobs, and what each host would lose beside them.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import BackupsTab from "../BackupsTab";
import { fetchBackups, fetchRecovery } from "../backupsApi";

vi.mock("../backupsApi", async (original) => ({ ...(await original()), fetchBackups: vi.fn(), fetchRecovery: vi.fn() }));

const now = Date.now() / 1000;
const job = (id, name, state, over = {}) => ({
  id,
  name,
  state,
  source_host: "bigboy",
  dest_host: "thinkpad",
  directory: "/backups/bigboy",
  volume: name,
  interval_hours: 24,
  keep: 7,
  enabled: true,
  last_success_at: now - 3600,
  last_archive: { bytes: 394e6 },
  ...over,
});

const machines = {
  bigboy: { online: true, backup: { state: "ok", last_success_age: 600 } },
  thinkpad: { online: true, backup: { state: "ok", last_success_age: 900 } },
};

const lost = {
  host: "bigboy",
  config_backup: { state: "ok" },
  unprotected_bytes: 184_320_000,
  ignored_count: 0,
  projects: [{ project: "jellyfin", items: [{ kind: "volume", name: "jellyfin_config", bytes: 184_320_000, protected_by: null, ignored: null }] }],
};
const safe = { host: "thinkpad", config_backup: { state: "ok" }, unprotected_bytes: 0, ignored_count: 0, projects: [] };

beforeEach(() => {
  fetchBackups.mockReset().mockResolvedValue({ backups: [job("b1", "qdrant", "ok"), job("b2", "uptime-kuma", "failing")], default_dest_host: "thinkpad" });
  fetchRecovery.mockReset().mockImplementation((host) => Promise.resolve(host === "bigboy" ? lost : safe));
});
afterEach(cleanup);

const open = (props = {}) => render(<BackupsTab machines={machines} connected onNavigate={vi.fn()} {...props} />);
const panel = (title) => screen.getByRole("heading", { name: title }).closest("section");

test("shows the jobs, worst first, beside what each host would lose", async () => {
  open();
  expect(await within(panel("Volume backups")).findByText("uptime-kuma")).toBeTruthy();
  const names = [...document.querySelectorAll(".backup-cell-job strong")].map((e) => e.textContent);
  expect(names).toEqual(["uptime-kuma", "qdrant"]);

  expect(await within(panel("If a host died")).findByText("176 MB at risk")).toBeTruthy();
  expect(within(panel("If a host died")).getByText("safe")).toBeTruthy();
});

test("adds up what is at risk once the agents have answered", async () => {
  open();
  const strip = document.querySelector(".facts-row");
  expect(await within(strip).findByText("176 MB")).toBeTruthy();
  expect(within(strip).getByText("At risk")).toBeTruthy();
});

test("its Recover link opens that host's Maintenance page", async () => {
  const onNavigate = vi.fn();
  open({ onNavigate });
  const recover = await within(panel("If a host died")).findAllByRole("button", { name: /Recover/ });
  fireEvent.click(recover[0]);
  expect(onNavigate).toHaveBeenCalledWith("hosts", { host: "bigboy", page: "manage" });
});

test("keeps the host's compose-file state when its agent can't give the report", async () => {
  fetchRecovery.mockRejectedValue(new Error("agent unreachable"));
  open();
  const dying = panel("If a host died");
  expect((await within(dying).findAllByText(/Couldn't ask/)).length).toBe(2);
  expect(within(dying).getAllByText("Backed up").length).toBe(2);
});

test("with no jobs it says what a backup is for, and still shows the hosts", async () => {
  fetchBackups.mockResolvedValue({ backups: [], default_dest_host: null });
  open();
  expect(await screen.findByText(/Nothing is backed up yet/)).toBeTruthy();
  expect(await within(panel("If a host died")).findByText("176 MB at risk")).toBeTruthy();
});
