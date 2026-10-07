import { describe, expect, it } from "vitest";
import { classify, layout, shortName } from "../topology";

const dev = (ip, extra = {}) => ({ ip, key: ip, ports: [], ...extra });

describe("classify", () => {
  it("knows your nodes and the gateway before anything else", () => {
    expect(classify(dev("192.168.1.10", { node: "bigboy", vendor: "Apple" }))).toBe("node");
    expect(classify(dev("192.168.1.1", { vendor: "Apple" }), { gateway: "192.168.1.1" })).toBe("router");
  });

  it("uses ports and vendors", () => {
    expect(classify(dev("10.0.0.5", { ports: [{ port: 631, service: "ipp" }] }))).toBe("printer");
    // 9100 alone is as likely node-exporter as a printer.
    expect(classify(dev("10.0.0.12", { ports: [{ port: 9100, service: "9100" }] }))).toBe("unknown");
    expect(classify(dev("10.0.0.6", { ports: [{ port: 8096, service: "jellyfin" }] }))).toBe("media");
    expect(classify(dev("10.0.0.7", { vendor: "Espressif Inc." }))).toBe("iot");
    expect(classify(dev("10.0.0.8", { ports: [{ port: 62078, service: "ios" }] }))).toBe("phone");
    expect(classify(dev("10.0.0.9", { randomized: true }))).toBe("phone");
    expect(classify(dev("10.0.0.10", { ports: [{ port: 22, service: "ssh" }] }))).toBe("server");
    expect(classify(dev("10.0.0.11"))).toBe("unknown");
  });
});

describe("layout", () => {
  it("puts every device somewhere, nodes on the inner ring", () => {
    const devices = [
      dev("10.0.0.2", { kind: "phone" }),
      dev("10.0.0.3", { kind: "node" }),
      ...Array.from({ length: 20 }, (_, i) => dev(`10.0.1.${i + 1}`, { kind: "unknown" })),
    ];
    const { positions } = layout(devices);
    expect(positions.size).toBe(devices.length);
    expect(positions.get("10.0.0.3").ring).toBe(0);
    expect(positions.get("10.0.0.2").ring).toBe(1);
  });

  it("leaves the top open for the Internet link", () => {
    const { positions } = layout([dev("10.0.0.2", { kind: "unknown" })]);
    const { x, y } = positions.get("10.0.0.2");
    // A lone device lands opposite the Internet link, not on it.
    expect(Math.abs(x)).toBeLessThan(1);
    expect(y).toBeGreaterThan(0);
  });
});

describe("layout size", () => {
  it("stretches to the area it is given", () => {
    const devices = Array.from({ length: 8 }, (_, i) => dev(`10.0.0.${i + 2}`, { kind: "unknown" }));
    const reach = (area) => Math.max(...[...layout(devices, area).positions.values()].map((p) => Math.abs(p.x)));
    expect(reach({ rx: 600, ry: 200 })).toBeGreaterThan(reach({ rx: 300, ry: 200 }));
    const { positions } = layout(devices, { rx: 600, ry: 200 });
    expect(Math.max(...[...positions.values()].map((p) => Math.abs(p.y)))).toBeLessThanOrEqual(200);
  });
});

describe("shortName", () => {
  it("prefers node name, then hostname, then the last two octets", () => {
    expect(shortName(dev("1.2.3.4", { node: "bigboy" }))).toBe("bigboy");
    expect(shortName(dev("1.2.3.4", { hostname: "printer.lan" }))).toBe("printer");
    expect(shortName(dev("192.168.1.42"))).toBe("1.42");
  });
});
