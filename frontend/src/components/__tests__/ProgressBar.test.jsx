import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import ProgressBar from "../ProgressBar";

afterEach(cleanup);

test("shows the percent and bytes when known", () => {
  render(<ProgressBar percent={42.4} label="Copying" done={1048576} total={4194304} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  expect(screen.getByText("42%")).toBeTruthy();
  expect(screen.getByText("1 MB / 4 MB")).toBeTruthy();
});

test("is indeterminate with no percent", () => {
  render(<ProgressBar percent={null} label="Measuring…" />);
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBeNull();
  expect(bar.className).toContain("pbar--indeterminate");
});

test("clamps out-of-range values", () => {
  render(<ProgressBar percent={180} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
});
