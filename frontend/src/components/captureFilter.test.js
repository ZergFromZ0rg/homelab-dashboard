import { describe, expect, it } from "vitest";
import { compileFilter, FilterError } from "./captureFilter";

const SYN = { proto: "TCP", ip: 4, src: "192.168.1.10", sport: 51000, dst: "192.168.1.1", dport: 443, len: 54, src_mac: "aa:bb:cc:00:00:01", dst_mac: "aa:bb:cc:00:00:02" };
const DNS = { proto: "UDP", ip: 4, app: "dns", src: "192.168.1.10", sport: 40000, dst: "8.8.8.8", dport: 53, len: 59 };
const HELLO = { ...SYN, app: "tls", sni: "plex.example.com", len: 140 };
const PING = { proto: "ICMP", ip: 4, src: "192.168.1.10", dst: "192.168.1.1", len: 42 };
const WEB = { ...SYN, dport: 80, app: "http", name: "Nas.LAN", len: 200 };
const BAD = { ...SYN, issues: ["retransmit"] };
const ALL = [SYN, DNS, HELLO, PING];
const run = (expr, packets = ALL) => packets.map((p) => compileFilter(expr)(p));

describe("display filter", () => {
  it.each([
    ["host 192.168.1.1", [true, false, true, true]],
    ["src host 192.168.1.1", [false, false, false, false]],
    ["dst host 8.8.8.8", [false, true, false, false]],
    ["port 443", [true, false, true, false]],
    ["dst port 53", [false, true, false, false]],
    ["tcp port 443 and not tls", [true, false, false, false]],
    ["portrange 50000-51000", [true, false, true, false]],
    ["net 192.168.1.0/24", [true, true, true, true]],
    ["dst net 8.8.0.0/16", [false, true, false, false]],
    ["udp or icmp", [false, true, false, true]],
    ["udp || icmp", [false, true, false, true]],
    ["not (port 443 or port 53)", [false, false, false, true]],
    ["! tcp", [false, true, false, true]],
    ["dns", [false, true, false, false]],
    ["tls", [false, false, true, false]],
    ["sni *.example.com", [false, false, true, false]],
    ["sni *.plex.example.com", [false, false, true, false]],
    ["sni *z.example.com", [false, false, false, false]],
    ["ether host aa:bb:cc:00:00:01", [true, false, true, false]],
    ["ether dst host aa:bb:cc:00:00:01", [false, false, false, false]],
    ["len > 100", [false, false, true, false]],
    ["less 50", [false, false, false, true]],
    ["greater 100", [false, false, true, false]],
    ["TCP PORT 443", [true, false, true, false]],
  ])("%s", (expr, expected) => {
    expect(run(expr)).toEqual(expected);
  });

  it("and binds tighter than or", () => {
    const f = compileFilter("icmp or tcp and port 80");
    expect(f(PING)).toBe(true);
    expect(f(SYN)).toBe(false);
  });

  it("knows the newer protocols, names and TCP problems", () => {
    expect(run("http", [WEB, SYN])).toEqual([true, false]);
    expect(run("name nas.lan", [WEB, SYN])).toEqual([true, false]);
    expect(run("name *.example.com", [HELLO, WEB])).toEqual([true, false]);
    expect(run("sni nas.lan", [WEB])).toEqual([false]);
    expect(run("retransmit", [BAD, SYN])).toEqual([true, false]);
    expect(run("problem", [BAD, SYN])).toEqual([true, false]);
    expect(run("tcp and not problem", [BAD, SYN])).toEqual([false, true]);
    expect(run("reset", [BAD])).toEqual([false]);
  });

  it.each([
    ["", "empty"], ["host", "ends too soon"], ["host nope", "isn't an IP"], ["port 99999", "isn't a port"],
    ["portrange 80", "needs a range"], ["portrange 90-80", "backwards"], ["net 10.0.0.0/99", "isn't a network"],
    ["net fe80::/10", "IPv4 networks only"], ["ether host zz", "isn't a MAC"], ["tcp[13] = 2", "isn't supported"],
    ["(port 80", "never closed"], ["port 80 port 443", "join conditions"], ["icmp port 80", "has no ports"],
    ["len ~ 5", "after 'len'"], ["frobnicate", "don't know"], ["host 1.2.3.4 &", "unexpected"],
    ["x".repeat(400), "longer than"], [`${"(".repeat(40)}tcp${")".repeat(40)}`, "nested"],
  ])("rejects %j", (expr, message) => {
    expect(() => compileFilter(expr)).toThrow(FilterError);
    expect(() => compileFilter(expr)).toThrow(message);
  });
});
