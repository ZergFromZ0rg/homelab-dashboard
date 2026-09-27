import { isMap, isScalar, isSeq, parseDocument } from "yaml";

// Structured edits to a compose file that leave everything else alone.
//
// The yaml library keeps comments, but printing a document back is still
// not byte-for-byte: a trailing space goes, a comment can move up a line.
// Shown in a diff, that noise would bury the one line you changed. So an
// edit is *rebased*: diff the reprinted original against the reprinted
// edit, and apply only those changed lines to the original text.

const PRINT = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false };

export const print = (doc) => doc.toString(PRINT);

// Longest common subsequence of lines, as [i, j] pairs. `same` decides what
// counts as equal.
function matches(a, b, same = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

// The printer's churn is mostly whitespace at line ends, so the reprint is
// lined up with the original ignoring that.
const looselySame = (x, y) => x.trimEnd() === y.trimEnd();

// Apply the change base → edited to original, where base is original as
// the library prints it.
export function rebase(original, base, edited) {
  if (base === edited) return original;
  const O = original.split("\n");
  const B = base.split("\n");
  const E = edited.split("\n");
  const toO = new Map(matches(B, O, looselySame));

  // Where base line b sits in the original: its match, or — for a line
  // the printer changed — one past the nearest matched line above it.
  const position = (b) => {
    for (let k = b; k >= 0; k -= 1) if (toO.has(k)) return toO.get(k) + (b - k);
    return b;
  };
  const anchorAfter = (b) => {
    for (let k = b; k < B.length; k += 1) if (toO.has(k)) return toO.get(k);
    return O.length;
  };

  const out = [];
  let cursor = 0;
  let pb = 0;
  let pe = 0;
  for (const [bi, ei] of [...matches(B, E), [B.length, E.length]]) {
    if (bi > pb || ei > pe) {
      const limit = anchorAfter(bi);
      const start = Math.min(Math.max(position(pb), cursor), limit);
      // Replace the original lines the removed base lines stood for.
      const end = bi > pb ? Math.min(Math.max(position(bi - 1) + 1, start), limit) : start;
      out.push(...O.slice(cursor, start), ...E.slice(pe, ei));
      cursor = end;
    }
    pb = bi + 1;
    pe = ei + 1;
  }
  out.push(...O.slice(cursor));
  return out.join("\n");
}

// --- reading and editing one service ----------------------------------------

export function parse(text) {
  const doc = parseDocument(text);
  return { doc, error: doc.errors[0]?.message ?? null };
}

const servicePath = (service, key) => ["services", service, key];

export function readService(doc, service) {
  const node = doc.getIn(["services", service], true);
  if (!isMap(node)) return null;
  const scalar = (key) => {
    const v = doc.getIn(servicePath(service, key), true);
    return isScalar(v) ? String(v.value ?? "") : v == null ? "" : null;
  };
  const list = (key) => {
    const v = doc.getIn(servicePath(service, key), true);
    if (v == null) return { items: [], style: "seq" };
    if (!isSeq(v)) return { items: null, style: "other" };
    return {
      style: "seq",
      items: v.items.map((item) =>
        isScalar(item) ? { text: String(item.value), editable: true } : { text: JSON.stringify(item.toJSON()), editable: false }
      ),
    };
  };
  const env = () => {
    const v = doc.getIn(servicePath(service, "environment"), true);
    if (v == null) return { style: "seq", items: [] };
    if (isSeq(v)) {
      return {
        style: "seq",
        items: v.items.map((item) => {
          const [key, ...rest] = String(isScalar(item) ? item.value : "").split("=");
          return { key, value: rest.join("="), bare: !String(item.value).includes("=") };
        }),
      };
    }
    if (isMap(v)) {
      return {
        style: "map",
        items: v.items.map((pair) => ({
          key: String(isScalar(pair.key) ? pair.key.value : pair.key),
          value: pair.value == null ? "" : String(isScalar(pair.value) ? pair.value.value ?? "" : pair.value),
        })),
      };
    }
    return { style: "other", items: null };
  };
  return {
    image: scalar("image"),
    restart: scalar("restart"),
    environment: env(),
    ports: list("ports"),
    volumes: list("volumes"),
  };
}

// Each edit mutates `doc` in place, touching only the node it changes, so
// comments on everything else stay where they were.

export function setScalar(doc, service, key, value) {
  const path = servicePath(service, key);
  const node = doc.getIn(path, true);
  if (!value) doc.deleteIn(path);
  else if (isScalar(node)) node.value = value;
  else doc.setIn(path, value);
}

export function setListItem(doc, service, key, index, value) {
  const path = servicePath(service, key);
  const node = doc.getIn(path, true);
  if (isSeq(node) && isScalar(node.items[index])) node.items[index].value = value;
}

export function addListItem(doc, service, key, value) {
  const path = servicePath(service, key);
  const node = doc.getIn(path, true);
  if (isSeq(node)) node.add(doc.createNode(value));
  else doc.setIn(path, doc.createNode([value]));
}

export function removeListItem(doc, service, key, index) {
  const path = servicePath(service, key);
  const node = doc.getIn(path, true);
  if (!isSeq(node)) return;
  node.items.splice(index, 1);
  if (node.items.length === 0) doc.deleteIn(path);
}

const envLine = (key, value) => `${key}=${value}`;

export function setEnv(doc, service, index, key, value) {
  const node = doc.getIn(servicePath(service, "environment"), true);
  if (isSeq(node) && isScalar(node.items[index])) node.items[index].value = envLine(key, value);
  if (isMap(node)) {
    const pair = node.items[index];
    if (isScalar(pair.key)) pair.key.value = key;
    if (isScalar(pair.value)) pair.value.value = value;
    else pair.value = doc.createNode(value);
  }
}

export function addEnv(doc, service, key, value) {
  const path = servicePath(service, "environment");
  const node = doc.getIn(path, true);
  if (isMap(node)) node.set(key, value);
  else if (isSeq(node)) node.add(doc.createNode(envLine(key, value)));
  else doc.setIn(path, doc.createNode([envLine(key, value)]));
}

export function removeEnv(doc, service, index) {
  const path = servicePath(service, "environment");
  const node = doc.getIn(path, true);
  if (!isSeq(node) && !isMap(node)) return;
  node.items.splice(index, 1);
  if (node.items.length === 0) doc.deleteIn(path);
}

// One structured edit, start to finish: parse, change, rebase onto the
// original text.
export function edit(text, change) {
  const base = print(parseDocument(text));
  const doc = parseDocument(text);
  change(doc);
  return rebase(text, base, print(doc));
}
