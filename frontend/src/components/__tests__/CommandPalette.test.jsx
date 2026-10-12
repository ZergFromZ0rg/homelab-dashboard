// ⌘K: filter by words, Enter runs the top result.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import CommandPalette from "../CommandPalette";

afterEach(cleanup);

test("finds a container and jumps to it", () => {
  const onNavigate = vi.fn();
  render(
    <CommandPalette
      tabs={[{ value: "containers", label: "Containers" }]}
      machines={{ bigboy: {} }}
      containers={{ bigboy: [{ id: "1", name: "jellyfin", status: "running", ports: [] }] }}
      control={{ run: vi.fn() }}
      onNavigate={onNavigate}
      onOpenSettings={vi.fn()}
    />
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = screen.getByRole("textbox", { name: "Search commands" });
  fireEvent.change(input, { target: { value: "jelly" } });
  expect(screen.getAllByRole("option")[0].textContent).toContain("jellyfin");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledWith("containers", { container: "jellyfin" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("nothing matches says so", () => {
  render(<CommandPalette tabs={[]} machines={{}} containers={{}} control={{}} onNavigate={vi.fn()} onOpenSettings={vi.fn()} />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz" } });
  expect(screen.getByText("Nothing matches.")).toBeTruthy();
});

test("every page of a host is a command that opens that page", () => {
  const onNavigate = vi.fn();
  render(
    <CommandPalette
      tabs={[{ value: "hosts", label: "Hosts" }]}
      machines={{ bigboy: {}, thinkpad: {} }}
      containers={{}}
      control={{}}
      onNavigate={onNavigate}
      onOpenSettings={vi.fn()}
    />
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = screen.getByRole("textbox", { name: "Search commands" });
  fireEvent.change(input, { target: { value: "packets bigboy" } });
  expect(screen.getAllByRole("option")[0].textContent).toContain("Packets on bigboy");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledWith("hosts", expect.objectContaining({ host: "bigboy", page: "packets" }));
});

test("a host on its own opens its summary, and files are its Storage page", () => {
  const onNavigate = vi.fn();
  render(
    <CommandPalette tabs={[]} machines={{ bigboy: {} }} containers={{}} control={{}} onNavigate={onNavigate} onOpenSettings={vi.fn()} />
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = screen.getByRole("textbox", { name: "Search commands" });
  fireEvent.change(input, { target: { value: "files on bigboy" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledWith("hosts", expect.objectContaining({ host: "bigboy", page: "storage" }));
});
