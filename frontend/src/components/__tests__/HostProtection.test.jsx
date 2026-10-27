// "If a host died": every host's verdict, worst first, with what to do about it.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import HostProtection from "../HostProtection";

afterEach(cleanup);

const item = (name, bytes, over = {}) => ({ kind: "volume", name, bytes, protected_by: null, ignored: null, partial: false, ...over });
const report = (projects, over = {}) => ({
  host: "x",
  config_backup: { state: "ok" },
  projects,
  unprotected_bytes: 0,
  ignored_count: 0,
  ...over,
});

const machines = {
  bigboy: { backup: { state: "ok", last_success_age: 7200 } },
  nuc: { backup: { state: "failing", last_error: "push rejected" } },
  thinkpad: { backup: { state: "ok", last_success_age: 600 } },
};

const recoveries = {
  bigboy: { data: report([{ project: "jellyfin", items: [item("jellyfin_config", 184_320_000)] }], { unprotected_bytes: 184_320_000 }), error: null },
  nuc: { data: report([]), error: null },
  thinkpad: { data: report([{ project: "a", settled: true, items: [item("v", 1, { protected_by: { job: "j", state: "ok" } })] }], { ignored_count: 1 }), error: null },
};

const open = (props = {}) => render(<HostProtection hosts={["bigboy", "nuc", "thinkpad"]} machines={machines} recoveries={recoveries} onRecover={vi.fn()} {...props} />);
const blocks = () => [...document.querySelectorAll(".bk-host")];

test("lists the hosts worst first and counts the ones at risk", () => {
  open();
  expect(blocks().map((b) => b.querySelector("strong").textContent)).toEqual(["bigboy", "nuc", "thinkpad"]);
  expect(screen.getByText("2 at risk")).toBeTruthy();
});

test("says what would be lost, what is behind and what is safe, in the host's own words", () => {
  open();
  const [bigboy, nuc, thinkpad] = blocks().map((b) => within(b));
  expect(bigboy.getByText("176 MB at risk")).toBeTruthy();
  expect(bigboy.getByText("1 stack not backed up")).toBeTruthy();
  expect(bigboy.getByText("jellyfin")).toBeTruthy();
  expect(bigboy.getByText("Backed up")).toBeTruthy();
  expect(bigboy.getByText("pushed 2h ago")).toBeTruthy();

  expect(nuc.getByText("backup failing")).toBeTruthy();
  expect(nuc.getByText("Failing")).toBeTruthy();
  expect(nuc.getByText("push rejected")).toBeTruthy();

  expect(thinkpad.getByText("safe")).toBeTruthy();
  expect(thinkpad.getByText("All backed up")).toBeTruthy();
  expect(thinkpad.getByText("1 skipped on purpose")).toBeTruthy();
});

test("a link per host opens that host's recovery, and so does a stack", () => {
  const onRecover = vi.fn();
  open({ onRecover });
  fireEvent.click(within(blocks()[0]).getByRole("button", { name: /Recover/ }));
  expect(onRecover).toHaveBeenCalledWith("bigboy");
  fireEvent.click(within(blocks()[0]).getByText("jellyfin"));
  expect(onRecover).toHaveBeenCalledTimes(2);
});

test("says it is looking before an agent has answered, and that it couldn't when it never does", () => {
  open({ recoveries: { bigboy: { data: null, error: "agent unreachable" } } });
  const bigboy = within(blocks().find((b) => b.textContent.includes("bigboy")));
  expect(bigboy.getByText("Couldn't ask bigboy")).toBeTruthy();
  const thinkpad = within(blocks().find((b) => b.textContent.includes("thinkpad")));
  expect(thinkpad.getByText("Looking…")).toBeTruthy();
  expect(thinkpad.getByText("checking…")).toBeTruthy();
});

test("with no servers it says so", () => {
  render(<HostProtection hosts={[]} machines={{}} recoveries={{}} onRecover={vi.fn()} />);
  expect(screen.getByText("No servers reporting yet.")).toBeTruthy();
});

test("shows the first three stacks and counts the rest", () => {
  const many = report(
    ["a", "b", "c", "d", "e"].map((name, i) => ({ project: name, items: [item(`${name}_v`, (i + 1) * 1e6)] })),
    { unprotected_bytes: 15e6 }
  );
  open({ hosts: ["bigboy"], recoveries: { bigboy: { data: many, error: null } } });
  expect(document.querySelectorAll(".bk-stack")).toHaveLength(3);
  expect(screen.getByText("+2 more")).toBeTruthy();
});
