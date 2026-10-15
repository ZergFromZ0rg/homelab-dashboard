// The Hosts tab's address inside the hash: `overview` for the whole fleet, or
// `<host>/<page>` for one machine (`bigboy/storage`). A bare host opens its
// Summary; a bare page (an old bookmark of #/god/files) opens that page on the
// host you were last looking at.

export const HOST_PAGES = [
  ["summary", "Summary"],
  ["history", "History"],
  ["storage", "Storage"],
  ["services", "Services"],
  ["network", "Network"],
  ["packets", "Packets"],
  ["manage", "Manage"],
];

const PAGE_IDS = HOST_PAGES.map(([id]) => id);

// What the row of pages shows: five entries, each a job. History is the
// "over time" view of Health, and Packets the "capture it" view of Network;
// both keep their own address, and a switch on the page moves between them.
// [entry id (the page it opens), label, [pages it covers], [[page, switch label]…]]
export const HOST_NAV = [
  ["summary", "Health", ["summary", "history"], [["summary", "Live"], ["history", "Over time"]]],
  ["storage", "Disks & files", ["storage"], []],
  ["services", "Services", ["services"], []],
  ["network", "Network", ["network", "packets"], [["network", "Traffic"], ["packets", "Packet capture"]]],
  ["manage", "Maintenance", ["manage"], []],
];

// The entry a page belongs to.
export function navEntry(page) {
  return HOST_NAV.find(([, , pages]) => pages.includes(page)) ?? HOST_NAV[0];
}

export function hostsSub(host, page = "summary") {
  return host ? `${host}/${page}` : "overview";
}

// -> { host, page }; host is null for the fleet overview. A host that isn't
// reporting (yet) falls back to the overview rather than a blank page.
export function parseHostsSub(sub, hosts, lastHost) {
  const [first = "", second] = String(sub || "").split("/");
  if (hosts.includes(first)) {
    return { host: first, page: PAGE_IDS.includes(second) ? second : "summary" };
  }
  if (PAGE_IDS.includes(first)) {
    const host = hosts.includes(lastHost) ? lastHost : hosts[0];
    return host ? { host, page: first } : { host: null, page: "summary" };
  }
  return { host: null, page: "summary" };
}
