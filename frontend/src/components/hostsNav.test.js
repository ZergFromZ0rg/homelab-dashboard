import { describe, expect, it } from "vitest";
import { hostsSub, parseHostsSub } from "./hostsNav";

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
