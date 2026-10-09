import { describe, expect, it } from "vitest";
import { label, nameIndex, observedNames } from "./captureNames";

describe("which name wins", () => {
  const sources = {
    nodes: { bigboy: [{ ip: "192.168.0.10" }], thinkpad: [{ ip: "192.168.0.132" }] },
    gateway: "192.168.0.1",
    contextNames: { "172.18.0.4": "qbittorrent", "192.168.0.132": "thinkpad-host" },
    seen: {
      "aa:bb": { ip: "192.168.0.50", mac: "aa:bb", hostname: "printer.lan" },
      "192.168.0.60": { ip: "192.168.0.60", mac: null, hostname: "tv.lan" },
    },
    custom: { "aa:bb": "Hall printer", "192.168.0.60": "Living room TV" },
    observed: { "104.18.32.7": "api.github.com", "192.168.0.10": "from-dns" },
  };
  const index = nameIndex(sources);
  const name = (ip) => index.get(ip)?.name;
  const kind = (ip) => index.get(ip)?.kind;

  it("your own name for a device beats its scan name, by MAC or by address", () => {
    expect(name("192.168.0.50")).toBe("Hall printer");
    expect(kind("192.168.0.50")).toBe("named by you");
    expect(name("192.168.0.60")).toBe("Living room TV");
  });

  it("a node beats a container name and anything seen in the capture", () => {
    expect(name("192.168.0.132")).toBe("thinkpad"); // not "thinkpad-host"
    expect(name("192.168.0.10")).toBe("bigboy"); // not the DNS-derived name
  });

  it("containers, the gateway and capture-seen names fill the rest", () => {
    expect(name("172.18.0.4")).toBe("qbittorrent");
    expect(name("192.168.0.1")).toBe("gateway");
    expect(name("104.18.32.7")).toBe("api.github.com");
    expect(kind("104.18.32.7")).toBe("seen in this capture");
  });

  it("the gateway label never replaces a real name for the router", () => {
    const named = nameIndex({ ...sources, custom: { "192.168.0.1": "Router" } });
    expect(named.get("192.168.0.1").name).toBe("Router");
    const node = nameIndex({ nodes: { router: [{ ip: "192.168.0.1" }] }, gateway: "192.168.0.1" });
    expect(node.get("192.168.0.1").name).toBe("router");
  });

  it("unknown addresses have no name, and a MAC-keyed rename is never mistaken for an address", () => {
    expect(index.get("8.8.8.8")).toBeUndefined();
    expect(nameIndex({ custom: { "aa:bb:cc:dd:ee:ff": "Phone" } }).size).toBe(0);
  });

  it("is case-insensitive for IPv6", () => {
    expect(nameIndex({ observed: { "2606:4700::AC42": "example.com" } }).get("2606:4700::ac42").name).toBe("example.com");
  });
});

describe("names the capture itself saw", () => {
  it("names the server a hello or a request was sent to, not the client", () => {
    const names = observedNames([
      { src: "192.168.0.5", dst: "140.82.121.4", sni: "github.com" },
      { src: "192.168.0.5", dst: "192.168.0.20", app: "http", name: "nas.lan:8080", info: "GET /x  Host: nas.lan:8080" },
    ]);
    expect(names).toEqual({ "140.82.121.4": "github.com", "192.168.0.20": "nas.lan" });
  });

  it("does not name anything from a response, a bare-address Host, or a DHCP client", () => {
    expect(observedNames([
      { src: "192.168.0.20", dst: "192.168.0.5", app: "http", name: "nas.lan", info: "HTTP 200 OK" },
      { src: "192.168.0.5", dst: "192.168.0.20", app: "http", name: "192.168.0.20:8080", info: "GET /  Host: 192.168.0.20:8080" },
      { src: "0.0.0.0", dst: "255.255.255.255", app: "dhcp", name: "esp-garage", info: "DHCP Request" },
    ])).toEqual({});
  });

  it("keeps DNS answers as the weakest evidence", () => {
    expect(observedNames([{ dst: "1.2.3.4", sni: "real.example.com" }], { "1.2.3.4": "asked.example.com", "5.6.7.8": "other.example.com" }))
      .toEqual({ "1.2.3.4": "real.example.com", "5.6.7.8": "other.example.com" });
  });
});

describe("how an endpoint is written", () => {
  const index = nameIndex({ contextNames: { "172.18.0.4": "qbittorrent" } });
  it("uses the name with the port", () => expect(label(index, "172.18.0.4", 8080)).toBe("qbittorrent:8080"));
  it("falls back to the address, bracketing IPv6", () => {
    expect(label(index, "10.0.0.9", 443)).toBe("10.0.0.9:443");
    expect(label(index, "2001:db8::1", 443)).toBe("[2001:db8::1]:443");
    expect(label(index, "10.0.0.9", undefined)).toBe("10.0.0.9");
  });
  it("shows plain addresses when names are switched off", () => {
    expect(label(index, "172.18.0.4", 8080, { names: false })).toBe("172.18.0.4:8080");
  });
});
