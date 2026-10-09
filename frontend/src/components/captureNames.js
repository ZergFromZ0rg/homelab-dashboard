// Calling an address by name in the packet list. Several things know names, and
// they disagree about how much to trust them, so this is the one place that
// says which wins. Highest first:
//
//   1. what you named the device (Network → Scans → rename)
//   2. a node of this dashboard ("bigboy"), and the host's gateway
//   3. a container ("jellyfin") or the capturing host itself — from the agent
//   4. the name a LAN scan found for it (its own reverse-DNS name)
//   5. a name the capture itself saw it given: the server a TLS hello or an
//      HTTP request was addressed to, or the name a DNS answer resolved to
//
// Nothing here asks the network: no reverse-DNS lookups go out for the
// addresses in a capture, so naming them can't leak who you were talking to.

const isRequest = (info) => /^(?!HTTP )[A-Z]+ \S/.test(info || ""); // "GET /x", not the "HTTP 200 OK" that answers it

// What the capture's own packets say about addresses: where a TLS hello or an
// HTTP request was *sent to* is that address's name. (DHCP host names belong to
// the client and are left out.)
export function observedNames(packets, dnsNames = {}) {
  const out = { ...dnsNames }; // DNS is the weakest evidence: a name that was asked for
  for (const p of packets) {
    if (p.sni && p.dst) out[p.dst] = p.sni;
    else if (p.app === "http" && p.name && p.dst && isRequest(p.info)) {
      const host = p.name.includes(":") && !p.name.includes("]") ? p.name.slice(0, p.name.lastIndexOf(":")) : p.name;
      if (!/^[\d.]+$/.test(host) && !host.includes(":")) out[p.dst] = host; // a Host that is just an address names nothing
    }
  }
  return out;
}

// address -> {name, kind}. `kind` says where the name came from, for the tooltip.
export function nameIndex({
  nodes = {}, // {host: [{ip, mac}]} — the dashboard's own nodes
  gateway = null,
  contextNames = {}, // {ip: name} from the agent: containers and the host itself
  seen = {}, // {key: {ip, mac, hostname}} — the last LAN scan, remembered by the browser
  custom = {}, // {mac-or-ip: name} — renames
  observed = {}, // {ip: name} from the capture
}) {
  const index = new Map();
  const put = (ip, name, kind) => {
    if (ip && name) index.set(ip.toLowerCase(), { name, kind });
  };

  for (const [ip, name] of Object.entries(observed)) put(ip, name, "seen in this capture");
  for (const entry of Object.values(seen)) {
    if (entry.hostname) put(entry.ip, entry.hostname, "found by a LAN scan");
  }
  for (const [ip, name] of Object.entries(contextNames)) put(ip, name, "container or this host");
  for (const [name, addresses] of Object.entries(nodes)) {
    for (const a of addresses || []) put(a.ip, name, "a node of this dashboard");
  }
  if (gateway && !index.has(gateway) && !Object.values(nodes).some((a) => (a || []).some((x) => x.ip === gateway))) {
    put(gateway, "gateway", "the default gateway");
  }
  for (const entry of Object.values(seen)) {
    const mine = custom[(entry.mac || entry.ip || "").toLowerCase()] || custom[(entry.ip || "").toLowerCase()];
    if (mine) put(entry.ip, mine, "named by you");
  }
  for (const [key, name] of Object.entries(custom)) {
    if (/^[\d.]+$|:/.test(key) && !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(key)) put(key, name, "named by you"); // an address, not a MAC
  }
  return index;
}

// "jellyfin:8096", or the plain "192.168.1.5:8096" when nothing names it.
export function label(index, ip, port, { names = true } = {}) {
  const found = names ? index.get((ip || "").toLowerCase()) : null;
  const shown = found ? found.name : ip;
  if (!port) return shown;
  return !found && ip.includes(":") ? `[${ip}]:${port}` : `${shown}:${port}`;
}
