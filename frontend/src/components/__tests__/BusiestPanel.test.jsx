// Who is using the most, across every server.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import BusiestPanel from "../BusiestPanel";

const c = (name, status, cpu, ram) => ({ id: name, name, status, stats: { cpu_percent: cpu, memory: { used_bytes: ram } } });
const fleet = {
  bigboy: [c("doc-service", "running", 186, 9.8 * 1024 ** 3), c("jellyfin", "running", 22.5, 1.4 * 1024 ** 3), c("old", "exited", 90, 1)],
  thinkpad: [c("grafana", "running", 3.2, 210 * 1024 ** 2)],
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const names = () => [...document.querySelectorAll(".hv-name-text")].map((e) => e.textContent);

test("ranks the running containers by CPU, with their server", () => {
  render(<BusiestPanel containers={fleet} onOpen={vi.fn()} />);
  expect(names()).toEqual(["doc-service", "jellyfin", "grafana"]);
  expect(screen.getByText("186%")).toBeTruthy();
  expect(screen.getByText("23%")).toBeTruthy();
  expect(screen.getByText("3.2%")).toBeTruthy();
  expect(screen.getAllByText("bigboy").length).toBe(2);
});

test("ranks by memory when asked, and remembers", () => {
  const { unmount } = render(<BusiestPanel containers={fleet} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  expect(screen.getByText("9.8 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Memory" }).getAttribute("aria-pressed")).toBe("true");
  unmount();
  render(<BusiestPanel containers={fleet} onOpen={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Memory" }).getAttribute("aria-pressed")).toBe("true");
});

test("a click opens the container on Containers", () => {
  const onOpen = vi.fn();
  render(<BusiestPanel containers={fleet} onOpen={onOpen} />);
  fireEvent.click(screen.getByText("jellyfin"));
  expect(onOpen).toHaveBeenCalledWith("jellyfin");
});

test("says so when nothing reports its usage", () => {
  render(<BusiestPanel containers={{}} onOpen={vi.fn()} />);
  expect(screen.getByText(/Nothing is reporting its usage yet/)).toBeTruthy();
});
