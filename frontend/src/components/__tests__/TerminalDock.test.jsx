// Shells only in God mode; logs in every mode.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import TerminalDock from "../TerminalDock";
import { useTerminal } from "../terminalContext";

afterEach(cleanup);

function Probe() {
  const terminal = useTerminal();
  return <span>{terminal.available("bigboy") ? "shell" : "no shell"}</span>;
}

const machines = { bigboy: { terminal: true } };

test("a host with shells offers one only when shells are on", () => {
  const { rerender } = render(
    <TerminalDock machines={machines} shells={false}>
      <Probe />
    </TerminalDock>
  );
  expect(screen.getByText("no shell")).toBeTruthy();

  rerender(
    <TerminalDock machines={machines} shells>
      <Probe />
    </TerminalDock>
  );
  expect(screen.getByText("shell")).toBeTruthy();
});
