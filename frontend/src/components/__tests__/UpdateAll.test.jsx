// Regression: "Update all (N)" once counted the filtered list but sent
// "everything on the host" — here it must send exactly what it counts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ContainerList from "../ContainerList";
import { SettingsProvider } from "../SettingsContext";
import { UpdatesContext } from "../updatesContext";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const container = (name, canUpdate) => ({
  id: `${name}-id`,
  name,
  image: `${name}:latest`,
  status: "running",
  compose_project: name,
  stats: {},
  update: canUpdate ? { state: "available", can_update: true, checked_at: 1 } : { state: "current" },
});

test("sends exactly the containers it counts", () => {
  localStorage.setItem("homelab.containerSearch", JSON.stringify("jelly"));
  const start = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(
    <SettingsProvider>
      <UpdatesContext.Provider value={{ jobs: {}, start, dismiss: vi.fn() }}>
        <ContainerList
          containers={{ box: [container("jellyfin", true), container("qbittorrent", true), container("nginx", false)] }}
          machines={{ box: {} }}
          onControl={{ pending: {}, errors: {}, run: vi.fn(), clearError: vi.fn() }}
          pins={[]}
          onSetPins={vi.fn()}
          connected
        />
      </UpdatesContext.Provider>
    </SettingsProvider>
  );

  fireEvent.click(screen.getByRole("button", { name: /Update all \(1\)/ }));
  expect(start).toHaveBeenCalledWith("box", ["jellyfin"]);
});
