// Regression: the settings panel opened inside a transformed, clipped
// container row and never showed. It must render at <body>.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../composeApi", () => ({
  fetchComposeSettings: vi.fn(() =>
    Promise.resolve({
      project: "media", service: "web", can_apply: true, working_dir: "/srv/media",
      files: [{ path: "/srv/media/compose.yml", content: "services:\n  web:\n    image: nginx\n",
                modified: 1, defines_service: true, writable: true }],
    })
  ),
  previewCompose: vi.fn(),
  applyCompose: vi.fn(),
  fetchComposeJob: vi.fn(),
}));

import { fetchComposeSettings } from "../composeApi";
import ContainerSettings from "../ContainerSettings";

afterEach(cleanup);

test("renders at the body, and asks for the container by name", async () => {
  render(
    <div style={{ transform: "translateY(0)", overflow: "hidden" }} data-testid="row">
      <ContainerSettings host="box" container={{ id: "abc123", name: "web" }} onClose={() => {}} />
    </div>
  );
  const dialog = await screen.findByRole("dialog", { name: "Settings for web" });
  expect(screen.getByTestId("row").contains(dialog)).toBe(false);
  expect(dialog.closest(".drawer-root").parentElement).toBe(document.body);
  // By name: applying recreates the container, and the new one has a new id.
  expect(fetchComposeSettings).toHaveBeenCalledWith("box", "web");
  expect(await screen.findByDisplayValue("nginx")).toBeTruthy();
});
