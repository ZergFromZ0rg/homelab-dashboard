import { describe, expect, it } from "vitest";
import { matchesPort, portRows } from "../containerPorts";

const web = (port, over = {}) => ({ port, scheme: "http", path: "/", status: 200, ok: true, host_rejected: false, ...over });

describe("portRows", () => {
  it("lists published ports lowest first, with the port inside", () => {
    const rows = portRows("bigboy", [
      { name: "jellyfin", status: "running", ports: { "8096/tcp": ["8096"] }, web: web(8096) },
      { name: "homepage", status: "running", ports: { "3000/tcp": ["3000"] }, web: web(3000) },
    ]);
    expect(rows.map((r) => [r.port, r.container, r.inside])).toEqual([
      [3000, "homepage", "3000"],
      [8096, "jellyfin", "8096"],
    ]);
  });

  it("keeps tcp and udp on the same number as two rows, and every host port of one mapping", () => {
    const rows = portRows("bigboy", [
      { name: "qbittorrent", status: "running", ports: { "6881/tcp": ["6881"], "6881/udp": ["6881"], "8080/tcp": ["8080"] }, web: web(8080) },
      { name: "docs", status: "running", ports: { "8000/tcp": ["3100", "8000"] }, web: null },
    ]);
    expect(rows.map((r) => `${r.port}/${r.proto}`)).toEqual(["3100/tcp", "6881/tcp", "6881/udp", "8000/tcp", "8080/tcp"]);
  });

  it("includes the ports a host-network container listens on, marked as such", () => {
    const rows = portRows("thinkpad", [
      { name: "pihole", status: "running", ports: {}, listening: [8053, 53], web: web(8053, { path: "/admin/" }) },
    ]);
    expect(rows.map((r) => [r.port, r.hostNetwork, r.inside])).toEqual([
      [53, true, null],
      [8053, true, null],
    ]);
  });

  it("links only the port the web UI is on", () => {
    const rows = portRows("thinkpad", [
      { name: "qbittorrent", status: "running", link_host: "10.0.0.5", ports: { "6881/tcp": ["6881"], "8080/tcp": ["8080"] }, web: web(8080) },
    ]);
    expect(rows.map((r) => r.url)).toEqual([null, "http://10.0.0.5:8080"]);
  });

  it("guesses the web port from the published ones for an agent that does not probe", () => {
    const rows = portRows("thinkpad", [{ name: "dash", status: "running", ports: { "80/tcp": ["8081"] } }]);
    expect(rows[0].url).toBe("http://thinkpad:8081");
  });

  it("keeps a stopped container's ports, flagged, and copes with nothing at all", () => {
    expect(portRows("h", [{ name: "off", status: "exited", ports: { "80/tcp": ["8082"] } }])[0].running).toBe(false);
    expect(portRows("h", [{ name: "bare" }, { name: "none", ports: null }])).toEqual([]);
    expect(portRows("h", undefined)).toEqual([]);
  });
});

describe("matchesPort", () => {
  const row = { port: 8096, container: "Jellyfin" };

  it("matches a container name anywhere, or the start of a port number", () => {
    expect(matchesPort(row, "")).toBe(true);
    expect(matchesPort(row, "jelly")).toBe(true);
    expect(matchesPort(row, "80")).toBe(true);
    expect(matchesPort(row, "96")).toBe(false);
    expect(matchesPort(row, "plex")).toBe(false);
  });
});
