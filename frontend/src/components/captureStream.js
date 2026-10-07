// "Follow TCP stream": put one connection's payload back in order from the
// packets on screen. Needs a capture made with whole packets kept; with less
// there is nothing to show and the result says so.
//
// Per direction: segments are ordered by sequence number, retransmitted bytes
// are dropped, and a hole (a packet the capture missed or sampled out) is
// reported as a gap instead of being papered over.

const CAP_BYTES = 200_000;

const seqDiff = (a, b) => (a - b) | 0; // signed 32-bit distance, so wraparound works

export function hexToBytes(hex) {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Printable ASCII and line breaks stay; everything else becomes a dot.
export function bytesToText(bytes) {
  let text = "";
  for (const b of bytes) {
    if (b === 10 || b === 13 || b === 9 || (b >= 32 && b < 127)) text += String.fromCharCode(b);
    else text += ".";
  }
  return text;
}

// One direction's bytes, in sequence order. Segments are sorted by their
// distance from the first one seen, so a packet that merely arrived late is
// put back where it belongs rather than reported as a hole.
function assemble(segments, dir, result) {
  const data = segments.filter((p) => p.plen);
  if (!data.length) return [];
  const syn = segments.find((p) => (p.flags || "").includes("S"));
  const base = syn ? (syn.seq + 1) >>> 0 : data[0].seq;
  const ordered = data
    .map((p) => ({ p, rel: seqDiff(p.seq, base) }))
    .sort((a, b) => a.rel - b.rel || a.p.ts - b.p.ts);

  const runs = [];
  let next = ordered[0].rel;
  let clock = 0; // never goes backwards, so merging the two directions by time keeps each one's order
  for (const { p, rel } of ordered) {
    result.segments += 1;
    clock = Math.max(clock, p.ts);
    if (rel + p.plen <= next) continue; // all of it was seen already: a retransmission
    if (rel > next) {
      result.gaps += 1;
      result.missing += rel - next;
      runs.push({ dir, ts: clock, gap: rel - next });
      next = rel;
    }
    const skip = next - rel; // bytes of this segment an earlier one already covered
    next = rel + p.plen;
    const offset = p.poff || 0;
    const available = Math.max(0, Math.min(p.plen, (p.hex || "").length / 2 - offset));
    if (available === 0) {
      result.headersOnly += 1;
      continue;
    }
    const bytes = hexToBytes(p.hex.slice(offset * 2, (offset + available) * 2)).subarray(skip);
    if (bytes.length) runs.push({ dir, ts: clock, bytes });
  }
  return runs;
}

export function followStream(packets, flow) {
  const segments = packets
    .filter((p) => p.flow === flow && p.proto === "TCP")
    .sort((a, b) => a.ts - b.ts || a.n - b.n);
  if (!segments.length) return null;

  const opener = segments.find((p) => (p.flags || "").includes("S") && !(p.flags || "").includes("A")) || segments[0];
  const client = `${opener.src}:${opener.sport}`;
  const isClient = (p) => `${p.src}:${p.sport}` === client;
  const other = segments.find((p) => !isClient(p));
  const result = {
    client, server: other ? `${other.src}:${other.sport}` : null, chunks: [],
    bytes: { client: 0, server: 0 }, gaps: 0, missing: 0, headersOnly: 0, segments: 0, capped: false,
  };

  const runs = [
    ...assemble(segments.filter(isClient), "client", result),
    ...assemble(segments.filter((p) => !isClient(p)), "server", result),
  ].sort((a, b) => a.ts - b.ts);

  let total = 0;
  for (const run of runs) {
    if (run.gap) {
      result.chunks.push({ dir: run.dir, gap: run.gap });
      continue;
    }
    if (total + run.bytes.length > CAP_BYTES) {
      result.capped = true;
      break;
    }
    total += run.bytes.length;
    result.bytes[run.dir] += run.bytes.length;
    const last = result.chunks[result.chunks.length - 1];
    const text = bytesToText(run.bytes);
    if (last && last.dir === run.dir && !last.gap) last.text += text;
    else result.chunks.push({ dir: run.dir, text, ts: run.ts });
  }
  return result;
}
