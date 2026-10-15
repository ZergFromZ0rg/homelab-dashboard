import { describe, expect, it } from "vitest";
import { HOST_NAV, hostsSub, navEntry, parseHostsSub } from "./hostsNav";

const hosts = ["bigboy", "thinkpad"];

describe("parseHostsSub", () => {
  it("reads the fleet overview", () => {
    expect(parseHostsSub("overview", hosts)).toEqual({ host: null, page: "summary" });
    expect(parseHostsSub("", hosts)).toEqual({ host: null, page: "summary" });
  });

  it("reads a host and its page", () => {
    expect(parseHostsSub("bigboy/storage", hosts)).toEqual({ host: "bigboy", page: "storage" });
    expect(parseHostsSub("thinkpad/packets", hosts)).toEqual({ host: "thinkpad", page: "packets" });
  });

  it("opens a bare host, or one with an unknown page, on its Summary", () => {
    expect(parseHostsSub("bigboy", hosts)).toEqual({ host: "bigboy", page: "summary" });
    expect(parseHostsSub("bigboy/nope", hosts)).toEqual({ host: "bigboy", page: "summary" });
  });

  it("puts a bare page on the host you were last on, else the first", () => {
    expect(parseHostsSub("storage", hosts, "thinkpad")).toEqual({ host: "thinkpad", page: "storage" });
    expect(parseHostsSub("storage", hosts, "gone")).toEqual({ host: "bigboy", page: "storage" });
  });

  it("falls back to the overview for a host that isn't reporting", () => {
    expect(parseHostsSub("ghost/storage", hosts)).toEqual({ host: null, page: "summary" });
    expect(parseHostsSub("storage", [])).toEqual({ host: null, page: "summary" });
  });

  it("lets a host be called like a page: the host wins", () => {
    expect(parseHostsSub("network", ["network"])).toEqual({ host: "network", page: "summary" });
  });
});

describe("hostsSub", () => {
  it("builds what it parses", () => {
    expect(hostsSub(null)).toBe("overview");
    expect(hostsSub("bigboy")).toBe("bigboy/summary");
    expect(parseHostsSub(hostsSub("thinkpad", "manage"), hosts)).toEqual({ host: "thinkpad", page: "manage" });
  });
});

describe("the row of pages", () => {
  it("shows five entries, each a job", () => {
    expect(HOST_NAV.map(([, label]) => label)).toEqual(["Health", "Disks & files", "Services", "Network", "Maintenance"]);
  });

  it("folds History into Health and Packets into Network, and keeps their addresses", () => {
    expect(navEntry("history")[0]).toBe("summary");
    expect(navEntry("packets")[0]).toBe("network");
    expect(parseHostsSub("bigboy/history", hosts)).toEqual({ host: "bigboy", page: "history" });
    expect(parseHostsSub("bigboy/packets", hosts)).toEqual({ host: "bigboy", page: "packets" });
  });

  it("gives the two-view entries a switch between their pages, and the rest none", () => {
    const views = Object.fromEntries(HOST_NAV.map(([id, , , v]) => [id, v.map(([page]) => page)]));
    expect(views.summary).toEqual(["summary", "history"]);
    expect(views.network).toEqual(["network", "packets"]);
    expect(views.storage).toEqual([]);
  });

  it("reaches every page the address can name", () => {
    for (const page of ["summary", "history", "storage", "services", "network", "packets", "manage"]) {
      expect(HOST_NAV.some(([, , pages]) => pages.includes(page)), page).toBe(true);
    }
  });
});
