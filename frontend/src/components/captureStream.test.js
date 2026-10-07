import { describe, expect, it } from "vitest";
import { bytesToText, followStream, hexToBytes } from "./captureStream";

const hex = (text) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const FLOW = "TCP|10.0.0.2|51000|10.0.0.9|80";
let n = 0;
const seg = (from, seq, text = "", flags = "A", extra = {}) => {
  const client = from === "c";
  return {
    n: ++n, ts: n, flow: FLOW, proto: "TCP", flags, seq, plen: text.length,
    src: client ? "10.0.0.2" : "10.0.0.9", sport: client ? 51000 : 80,
    dst: client ? "10.0.0.9" : "10.0.0.2", dport: client ? 80 : 51000,
    poff: 2, hex: "aabb" + hex(text), ...extra,
  };
};

describe("follow stream", () => {
  it("rebuilds a request and its response in order", () => {
    n = 0;
    const out = followStream([
      seg("c", 100, "", "S"),
      seg("s", 500, "", "SA"),
      seg("c", 101, "GET / HTTP/1.1\r\n", "PA"),
      seg("s", 501, "HTTP/1.1 200 OK\r\n", "PA"),
      seg("s", 518, "hello", "PA"),
    ], FLOW);
    expect(out.chunks.map((c) => [c.dir, c.text])).toEqual([
      ["client", "GET / HTTP/1.1\r\n"],
      ["server", "HTTP/1.1 200 OK\r\nhello"],
    ]);
    expect(out.bytes).toEqual({ client: 16, server: 22 });
    expect(out.gaps).toBe(0);
  });

  it("drops retransmitted bytes and trims overlaps", () => {
    n = 0;
    const out = followStream([
      seg("c", 1, "abcdef", "PA"),
      seg("c", 1, "abcdef", "PA"), // exact retransmission
      seg("c", 4, "defgh", "PA"), // overlaps "def", adds "gh"
    ], FLOW);
    expect(out.chunks.map((c) => c.text)).toEqual(["abcdefgh"]);
  });

  it("reports a hole as a gap", () => {
    n = 0;
    const out = followStream([seg("c", 1, "aaaa", "PA"), seg("c", 20, "bbbb", "PA")], FLOW);
    expect(out.gaps).toBe(1);
    expect(out.missing).toBe(15);
    expect(out.chunks.map((c) => c.gap || c.text)).toEqual(["aaaa", 15, "bbbb"]);
  });

  it("puts a late packet back in order instead of calling it a gap", () => {
    n = 0;
    const out = followStream([
      seg("c", 1, "aaa", "PA"),
      seg("c", 7, "ccc", "PA"), // arrives before the one it follows
      seg("c", 4, "bbb", "PA"),
    ], FLOW);
    expect(out.chunks.map((c) => c.text)).toEqual(["aaabbbccc"]);
    expect(out.gaps).toBe(0);
  });

  it("copes with sequence numbers wrapping around 2^32", () => {
    n = 0;
    const out = followStream([seg("c", 0xfffffffe, "ab", "PA"), seg("c", 0, "cd", "PA")], FLOW);
    expect(out.chunks.map((c) => c.text)).toEqual(["abcd"]);
    expect(out.gaps).toBe(0);
  });

  it("says when the capture kept headers only", () => {
    n = 0;
    const out = followStream([seg("c", 1, "abc", "PA", { hex: "aabb" })], FLOW);
    expect(out.headersOnly).toBe(1);
    expect(out.chunks).toEqual([]);
  });

  it("uses only the requested flow, and returns null for none", () => {
    n = 0;
    expect(followStream([seg("c", 1, "x", "PA", { flow: "other" })], FLOW)).toBeNull();
  });

  it("converts hex and masks unprintable bytes", () => {
    expect([...hexToBytes("00ff10")]).toEqual([0, 255, 16]);
    expect(bytesToText(new Uint8Array([72, 105, 13, 10, 0, 200]))).toBe("Hi\r\n..");
  });
});
