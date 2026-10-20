// "Why is it busy?": the verdict, each finding with its level, and buttons
// only for what the row can actually do.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import WhyPanel from "../WhyPanel";
import { fetchWhy } from "../whyApi";

vi.mock("../whyApi", () => ({ fetchWhy: vi.fn() }));

const container = { id: "a8", name: "doc-service" };

const answer = {
  host: "bigboy",
  container: "doc-service",
  headline: "CPU 186% (1.9 vCPU), far above its usual 2.8%. RAM 9.8 GB, steady.",
  attention: true,
  findings: [
    { level: "warn", key: "cpu_high", title: "CPU has been high for 2h 40m", detail: "A job, not a blip.", at: 1_800_000_000 },
    { level: "ok", key: "mem_steady", title: "Memory is steady", detail: "9.8 GB, flat.", at: null },
  ],
  suggestions: [
    { action: "logs", text: "Read its logs for what it was doing." },
    { action: "details", text: "Open its history." },
  ],
  evidence: {
    now: { cpu_percent: 186, memory_bytes: 10 * 1024 ** 3, memory_limit_bytes: null, disk_read_bps: 0, disk_write_bps: 0, net_rx_bps: 0, net_tx_bps: 0 },
    usual: { cpu: { median: 2.8, p90: 3.2 }, memory: null },
    history_hours: 167.9,
    host: { name: "bigboy", cpu_percent: 38, ram_percent: 52 },
    neighbours: [{ name: "jellyfin", cpu: 22.5, mem: 1 }],
    events: [{ at: 1_800_000_000, text: "doc-service recreated" }],
  },
};

beforeEach(() => {
  fetchWhy.mockReset();
});
afterEach(cleanup);

const open = (actions = {}) => render(<WhyPanel host="bigboy" container={container} actions={actions} onClose={() => {}} />);

test("shows the verdict and every finding once it loads", async () => {
  fetchWhy.mockResolvedValue(answer);
  open();

  expect(screen.getByText(/Looking at its history/)).toBeTruthy();
  expect(await screen.findByText(answer.headline)).toBeTruthy();
  expect(screen.getByText("CPU has been high for 2h 40m")).toBeTruthy();
  expect(screen.getByText("Memory is steady")).toBeTruthy();
  expect(screen.getByText("CPU has been high for 2h 40m").closest("li").className).toContain("why-item--warn");
  expect(fetchWhy).toHaveBeenCalledWith("bigboy", container);
});

test("a suggestion is a button when the row can do it, and plain text when it can't", async () => {
  fetchWhy.mockResolvedValue(answer);
  const logs = vi.fn();
  open({ logs });

  await screen.findByText(answer.headline);
  fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
  expect(logs).toHaveBeenCalledOnce();

  expect(screen.queryByRole("button", { name: "Show history" })).toBeNull();
  expect(screen.getByText("Open its history.")).toBeTruthy();
});

test("the numbers are behind a toggle", async () => {
  fetchWhy.mockResolvedValue(answer);
  open();

  await screen.findByText(answer.headline);
  expect(screen.queryByText("CPU usually")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show the numbers" }));
  expect(screen.getByText("CPU usually")).toBeTruthy();
  expect(screen.getByText(/2\.8% · up to 3\.2% nine times in ten/)).toBeTruthy();
  expect(screen.getByText("not enough history yet")).toBeTruthy();
  expect(screen.getByText(/jellyfin 23%/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Hide the numbers" }));
  expect(screen.queryByText("CPU usually")).toBeNull();
});

test("a failed request says so instead of staying on 'looking'", async () => {
  fetchWhy.mockRejectedValue(new Error("bigboy has no container called doc-service"));
  open();

  await waitFor(() => expect(screen.getByText("Couldn't work that out")).toBeTruthy());
  expect(screen.getByText("bigboy has no container called doc-service")).toBeTruthy();
});

test("close calls back", async () => {
  fetchWhy.mockResolvedValue(answer);
  const onClose = vi.fn();
  render(<WhyPanel host="bigboy" container={container} actions={{}} onClose={onClose} />);

  await screen.findByText(answer.headline);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
});
