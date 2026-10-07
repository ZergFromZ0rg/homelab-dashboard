// Display filter for the captured packet list: the same expression language
// the agent accepts when a capture starts (host / net / port / portrange,
// protocols, ether, len, sni / name, TCP problems, and / or / not), applied
// here to packets already on screen — so it works on live and saved captures
// alike, instantly, without asking the agent.
//
// This is a port of the agent's capture_filter.py. Two differences: `net` only
// takes IPv4 networks, and IPv6 hosts must be written the way the packet list
// shows them (compressed, lower case).

export class FilterError extends Error {}

const APP = new Set(["dns", "tls", "http", "dhcp", "ntp"]);
const PROTOCOLS = new Set(["tcp", "udp", "icmp", "icmp6", "arp", "ip", "ip6", ...APP]);
const DIRECTIONS = new Set(["src", "dst"]);
const ISSUES = { retransmit: "retransmit", reset: "reset", zerowindow: "zero-window", dupack: "dup-ack", gap: "gap" };
const UNSUPPORTED = new Set(["vlan", "proto", "gateway", "broadcast", "multicast"]);
const MAX_LENGTH = 300;
const MAX_DEPTH = 16;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

function tokenize(text) {
  const out = [];
  const re = /\s*(&&|\|\||<=|>=|==|[()!<>=]|[^\s()!<>=&|]+)/y;
  const trimmed = text.trim();
  let pos = 0;
  while (pos < trimmed.length) {
    re.lastIndex = pos;
    const match = re.exec(trimmed);
    if (!match) throw new FilterError(`unexpected '${trimmed.slice(pos, pos + 8)}'`);
    out.push(match[1]);
    pos = re.lastIndex;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos += 1;
  }
  return out;
}

function protocol(name) {
  if (name === "ip") return (p) => p.ip === 4;
  if (name === "ip6") return (p) => p.ip === 6;
  if (name === "icmp6") return (p) => p.proto === "ICMPv6";
  if (APP.has(name)) return (p) => p.app === name;
  const wanted = name.toUpperCase();
  return (p) => p.proto === wanted;
}

function address(value) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) return value;
  if (value.includes(":") && /^[0-9a-f:.]+$/i.test(value)) return value.toLowerCase();
  throw new FilterError(`'${value}' isn't an IP address`);
}

function port(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new FilterError(`'${value}' isn't a port (1-65535)`);
  }
  return Number(value);
}

const ipv4ToInt = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

function side(direction, a, b, test) {
  const has = (p, key) => p[key] != null && test(p[key]);
  if (direction === "src") return (p) => has(p, a);
  if (direction === "dst") return (p) => has(p, b);
  return (p) => has(p, a) || has(p, b);
}

const all = (...parts) => {
  const active = parts.filter(Boolean);
  return (p) => active.every((f) => f(p));
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.pos < this.tokens.length ? this.tokens[this.pos].toLowerCase() : null;
  }

  take() {
    if (this.pos >= this.tokens.length) throw new FilterError("the expression ends too soon");
    return this.tokens[this.pos++];
  }

  expect(word) {
    const got = this.take();
    if (got.toLowerCase() !== word) throw new FilterError(`expected '${word}', found '${got}'`);
  }

  parse() {
    if (!this.tokens.length) throw new FilterError("the filter is empty");
    const node = this.or(0);
    if (this.pos < this.tokens.length) {
      throw new FilterError(`unexpected '${this.tokens[this.pos]}' — join conditions with and / or`);
    }
    return node;
  }

  or(depth) {
    const parts = [this.and(depth)];
    while (["or", "||"].includes(this.peek())) {
      this.take();
      parts.push(this.and(depth));
    }
    return parts.length === 1 ? parts[0] : (p) => parts.some((f) => f(p));
  }

  and(depth) {
    const parts = [this.unary(depth)];
    while (["and", "&&"].includes(this.peek())) {
      this.take();
      parts.push(this.unary(depth));
    }
    return parts.length === 1 ? parts[0] : (p) => parts.every((f) => f(p));
  }

  unary(depth) {
    if (depth > MAX_DEPTH) throw new FilterError("too many nested parentheses");
    if (["not", "!"].includes(this.peek())) {
      this.take();
      const inner = this.unary(depth + 1);
      return (p) => !inner(p);
    }
    if (this.peek() === "(") {
      this.take();
      const inner = this.or(depth + 1);
      if (this.peek() !== ")") throw new FilterError("a '(' is never closed");
      this.take();
      return inner;
    }
    return this.primitive();
  }

  primitive() {
    const first = this.take();
    let word = first.toLowerCase();
    if (UNSUPPORTED.has(word) || word.includes("[")) throw new FilterError(`'${first}' isn't supported here`);
    if (word in ISSUES) {
      const wanted = ISSUES[word];
      return (p) => (p.issues || []).includes(wanted);
    }
    if (word === "problem") return (p) => Boolean(p.issues && p.issues.length);

    let qualifier = null;
    if (PROTOCOLS.has(word)) {
      qualifier = word;
      const next = this.peek();
      if (!DIRECTIONS.has(next) && !["host", "net", "port", "portrange"].includes(next)) return protocol(word);
      word = this.take().toLowerCase();
    }

    if (word === "ether") return this.ether();
    if (["len", "less", "greater"].includes(word)) {
      if (qualifier) throw new FilterError(`'${qualifier}' can't qualify '${word}'`);
      return this.length(word);
    }
    if (word === "sni" || word === "name") {
      if (qualifier) throw new FilterError(`'${qualifier}' can't qualify '${word}'`);
      return this.named(word);
    }

    let direction = null;
    if (DIRECTIONS.has(word)) {
      direction = word;
      word = this.take().toLowerCase();
    }
    const kind = qualifier ? protocol(qualifier) : null;
    if (word === "host") {
      const ip = address(this.take());
      return all(kind, side(direction, "src", "dst", (v) => v === ip));
    }
    if (word === "net") {
      const spec = this.take();
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(spec);
      if (!m && spec.includes(":")) throw new FilterError("the display filter takes IPv4 networks only");
      if (!m || m[1].split(".").some((n) => Number(n) > 255) || (m[2] != null && Number(m[2]) > 32)) {
        throw new FilterError(`'${spec}' isn't a network (try 192.168.1.0/24)`);
      }
      const bits = m[2] == null ? 32 : Number(m[2]);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const base = (ipv4ToInt(m[1]) & mask) >>> 0;
      const inside = (v) => /^\d+\.\d+\.\d+\.\d+$/.test(v) && ((ipv4ToInt(v) & mask) >>> 0) === base;
      return all(kind, side(direction, "src", "dst", inside));
    }
    if (word === "port" || word === "portrange") {
      if (["icmp", "icmp6", "arp"].includes(qualifier)) throw new FilterError(`'${qualifier}' has no ports`);
      const spec = this.take();
      let low;
      let high;
      if (word === "port") {
        low = port(spec);
        high = low;
      } else {
        const [a, b] = spec.split("-");
        if (b === undefined) throw new FilterError("portrange needs a range such as 5000-5100");
        low = port(a);
        high = port(b);
        if (low > high) throw new FilterError(`'${spec}' runs backwards`);
      }
      const hasPorts = (p) => p.proto === "TCP" || p.proto === "UDP";
      return all(kind, hasPorts, side(direction, "sport", "dport", (v) => v >= low && v <= high));
    }
    throw new FilterError(`don't know '${first}' — try host, net, port, portrange, a protocol, or len`);
  }

  ether() {
    let direction = null;
    if (DIRECTIONS.has(this.peek())) direction = this.take().toLowerCase();
    this.expect("host");
    const mac = this.take().toLowerCase();
    if (!MAC.test(mac)) throw new FilterError(`'${mac}' isn't a MAC address (aa:bb:cc:dd:ee:ff)`);
    return side(direction, "src_mac", "dst_mac", (v) => v === mac);
  }

  length(word) {
    let op = { less: "<=", greater: ">=" }[word];
    if (!op) {
      op = this.take();
      if (!["<", "<=", ">", ">=", "=", "=="].includes(op)) {
        throw new FilterError(`after 'len' use < <= > >= or =, not '${op}'`);
      }
    }
    const number = this.take();
    if (!/^\d+$/.test(number)) throw new FilterError(`'${number}' isn't a number`);
    const n = Number(number);
    const compare = {
      "<": (v) => v < n, "<=": (v) => v <= n, ">": (v) => v > n,
      ">=": (v) => v >= n, "=": (v) => v === n, "==": (v) => v === n,
    }[op];
    return (p) => compare(p.len || 0);
  }

  named(word) {
    const pattern = this.take().toLowerCase();
    if (!/^[a-z0-9*._-]{1,253}$/.test(pattern)) throw new FilterError(`'${pattern}' isn't a host name`);
    const bare = pattern.startsWith("*.") ? pattern.slice(2) : null; // *.example.com covers example.com too
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const fields = word === "sni" ? ["sni"] : ["sni", "name"];
    return (p) =>
      fields.some((f) => {
        const name = (p[f] || "").toLowerCase();
        return name && (regex.test(name) || name === bare);
      });
  }
}

// A predicate over a packet; throws FilterError saying why not.
export function compileFilter(text) {
  const source = (text || "").trim();
  if (source.length > MAX_LENGTH) throw new FilterError(`the filter is longer than ${MAX_LENGTH} characters`);
  return new Parser(tokenize(source)).parse();
}
