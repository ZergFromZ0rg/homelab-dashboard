// The servers panel: three meters per server, and under them a line of facts.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import HostSummary from "../HostSummary";

afterEach(cleanup);

const machine = (over = {}) => ({
  online: true,
  cpu: 38,
  ram: 71,
  uptime: 41 * 86400,
  temperature: 58,
  filesystems: [{ mountpoint: "/mnt/media", used_percent: 88 }],
  host_facts: { os_updates: 12, security_updates: 3, reboot_required: false, failed_units: ["nginx.service"] },
  ...over,
});

test("says how long a server has been up, how warm it is, and only what needs a look", () => {
  render(<HostSummary machines={{ bigboy: machine() }} containers={{ bigboy: [] }} onOpen={() => {}} />);
  expect(screen.getByText("up 41d 0h")).toBeTruthy();
  expect(screen.getByText("58°C")).toBeTruthy();
  expect(screen.getByText("12 updates").className).toContain("ov-fact--warn");
  expect(screen.getByText("1 failed").className).toContain("ov-fact--bad");
});

test("has no facts for a server that is off", () => {
  render(<HostSummary machines={{ bigboy: machine({ online: false }) }} containers={{ bigboy: [] }} onOpen={() => {}} />);
  expect(screen.getByText("offline")).toBeTruthy();
  expect(document.querySelector(".ov-host-facts")).toBeNull();
});
