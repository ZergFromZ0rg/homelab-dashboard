// Labelled row actions and the More menu that says what each entry does.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RowAction, RowMenu } from "../RowActions";

afterEach(cleanup);

test("an action shows its name, not just an icon", () => {
  render(<RowAction icon="stop" label="Stop" title="Stop this container" onClick={() => {}} />);
  const button = screen.getByRole("button", { name: "Stop" });
  expect(button.textContent).toBe("Stop");
  expect(button.getAttribute("title")).toBe("Stop this container");
});

test("a working action is disabled and says so", () => {
  render(<RowAction icon="refresh" label="Restart" working onClick={() => {}} />);
  const button = screen.getByRole("button", { name: "Restart" });
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
});

test("the menu opens on click and each entry explains itself", () => {
  render(<RowMenu items={[{ icon: "terminal", label: "Open a shell", hint: "A terminal inside this container", onClick: () => {} }]} />);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /More/ }));
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(screen.getByText("Open a shell")).toBeTruthy();
  expect(screen.getByText("A terminal inside this container")).toBeTruthy();
});

test("choosing an entry runs it and closes the menu", () => {
  const run = vi.fn();
  render(<RowMenu items={[{ icon: "sliders", label: "Edit its compose file", onClick: run }]} />);
  fireEvent.click(screen.getByRole("button", { name: /More/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit its compose file/ }));
  expect(run).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape and a click elsewhere close it", () => {
  render(<RowMenu items={[{ icon: "sliders", label: "Edit", onClick: () => {} }]} />);
  fireEvent.click(screen.getByRole("button", { name: /More/ }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /More/ }));
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("entries that don't apply are left out, and a menu with none shows no button", () => {
  const { container } = render(<RowMenu items={[false, null, undefined]} />);
  expect(container.textContent).toBe("");
});
