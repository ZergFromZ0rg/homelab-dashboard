import { describe, expect, it } from "vitest";
import { resolveTarget } from "./navTargets";

describe("resolveTarget", () => {
  it("sends the old Servers and Overview to the fleet overview, or to one host's Summary", () => {
    expect(resolveTarget("servers")).toEqual({ tab: "hosts", sub: "overview" });
    expect(resolveTarget("overview", { section: "timeline" })).toEqual({ tab: "hosts", sub: "overview" });
    expect(resolveTarget("servers", { host: "bigboy" })).toEqual({ tab: "hosts", sub: "bigboy/summary" });
  });

  it("turns what a link wanted to do on a host into the page that does it", () => {
    expect(resolveTarget("servers", { host: "bigboy", action: "os-updates" })).toEqual({ tab: "hosts", sub: "bigboy/manage" });
    expect(resolveTarget("servers", { host: "bigboy", action: "files" })).toEqual({ tab: "hosts", sub: "bigboy/storage" });
    expect(resolveTarget("hosts", { host: "thinkpad", page: "packets" })).toEqual({ tab: "hosts", sub: "thinkpad/packets" });
  });

  it("opens Hosts where it was left when no host is named", () => {
    expect(resolveTarget("hosts")).toEqual({ tab: "hosts", sub: null });
    expect(resolveTarget("terminal")).toEqual({ tab: "hosts", sub: null });
  });

  it("maps the old Files, System and Packets tabs onto host pages", () => {
    expect(resolveTarget("files", { host: "bigboy", path: "/srv" })).toEqual({ tab: "hosts", sub: "bigboy/storage" });
    expect(resolveTarget("files")).toEqual({ tab: "hosts", sub: "storage" });
    expect(resolveTarget("system")).toEqual({ tab: "hosts", sub: "services" });
    expect(resolveTarget("packets", { host: "bigboy" })).toEqual({ tab: "hosts", sub: "bigboy/packets" });
    expect(resolveTarget("packets")).toEqual({ tab: "hosts", sub: "packets" });
  });

  it("keeps Network, Containers and Backups as tabs", () => {
    expect(resolveTarget("network")).toEqual({ tab: "network", sub: null });
    expect(resolveTarget("network", { section: "dns" })).toEqual({ tab: "network", sub: "dns" });
    expect(resolveTarget("containers")).toEqual({ tab: "containers", sub: null });
    expect(resolveTarget("backups")).toEqual({ tab: "backups", sub: null });
  });
});
