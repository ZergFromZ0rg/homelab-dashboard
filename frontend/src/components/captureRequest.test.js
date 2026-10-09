import { afterEach, describe, expect, it, vi } from "vitest";
import { requestContainerCapture, resetCaptureRequests, takeCaptureTarget } from "./captureRequest";

describe("capture requests from a container row", () => {
  afterEach(() => {
    resetCaptureRequests();
    vi.useRealTimers();
  });

  it("hands the container to the Packets view of that host, once", () => {
    requestContainerCapture("bigboy", "jellyfin");
    expect(takeCaptureTarget("thinkpad")).toBeNull(); // another host's view must not take it
    expect(takeCaptureTarget("bigboy")).toBe("jellyfin");
    expect(takeCaptureTarget("bigboy")).toBeNull(); // consumed
  });

  it("goes stale: a click nobody picked up does not surprise a later visit", () => {
    vi.useFakeTimers();
    requestContainerCapture("bigboy", "jellyfin");
    vi.advanceTimersByTime(9000);
    expect(takeCaptureTarget("bigboy")).toBeNull();
  });

  it("asks the app to open the Network tab, and tells anyone listening", () => {
    const navigate = vi.fn();
    const heard = vi.fn();
    window.addEventListener("homelab:navigate", (e) => navigate(e.detail.target));
    window.addEventListener("homelab:capture-request", (e) => heard(e.detail.container));
    requestContainerCapture("bigboy", "qbittorrent");
    expect(navigate).toHaveBeenCalledWith("network");
    expect(heard).toHaveBeenCalledWith("qbittorrent");
  });

  it("the latest click wins", () => {
    requestContainerCapture("bigboy", "jellyfin");
    requestContainerCapture("bigboy", "nextcloud");
    expect(takeCaptureTarget("bigboy")).toBe("nextcloud");
  });
});
