// Names and small helpers shared by the packet viewer's parts.

// TCP problems the capture flags, by how bad they look.
export const BAD = new Set(["reset", "zero-window"]);
export const ISSUE_NAMES = {
  retransmit: "Retransmissions", gap: "Gaps (lost or reordered)", "dup-ack": "Duplicate ACKs",
  "zero-window": "Zero windows", reset: "Resets",
};
// The filter word that selects each problem.
export const ISSUE_WORDS = { retransmit: "retransmit", gap: "gap", "dup-ack": "dupack", "zero-window": "zerowindow", reset: "reset" };
export const DIRECTION = { out: "leaving this host", other: "someone else's traffic (promiscuous)", in: "arriving" };

export const flowKey = (f) => `${f.proto}|${f.a}|${f.a_port}|${f.b}|${f.b_port}`;
export const endpoint = (ip, port) => (port ? (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`) : ip);

// Packets and bytes a second, from the last few seconds.
export function rate(series) {
  const tail = series.slice(-3);
  if (!tail.length) return { pkts: 0, bytes: 0 };
  return {
    pkts: Math.round(tail.reduce((n, p) => n + p.pkts, 0) / tail.length),
    bytes: Math.round(tail.reduce((n, p) => n + p.bytes, 0) / tail.length),
  };
}
