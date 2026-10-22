// One plain sentence per page: what it is for. Shown under the navigation, so
// nobody has to guess what a tab is about. Written as the question you came
// with or the job you came to do.

const TAB = {
  containers: "Everything running on your servers — see how each is doing, open it, stop it, update it.",
  backups: "Is your data safe? Which copies exist, how recent they are, and what is behind.",
};

const OVERVIEW = "Is anything wrong? The state of every server, what needs you, and what just happened.";

const HOST = {
  summary: (h) => `How ${h} is doing right now — processor, memory, disks, temperatures.`,
  history: (h) => `How ${h} has been doing — the same numbers over the last hours, days or weeks.`,
  storage: (h) => `Where ${h}'s space went — its disks, and the folders and files you can browse and clean up.`,
  services: (h) => `What ${h}'s operating system is running, and its logs.`,
  network: (h) => `Where ${h}'s traffic goes — by container, interface and Docker network.`,
  packets: (h) => `Record ${h}'s traffic and see who is talking to whom (a Wireshark-style capture).`,
  manage: (h) => `Change ${h}: install OS updates, reboot or power it off, edit its agent's settings.`,
};

const NETWORK = {
  overview: "Is the network all right? Services, internet, DNS and the switch in one window.",
  checks: "Is each of your services answering? Get told when one stops.",
  dns: "What Pi-hole is blocking and who is asking — and a switch to pause it.",
  bandwidth: "How fast the internet is, and which devices are using it.",
  switch: "The state of every port on your network switch.",
  scan: "Find every device on your network.",
  watch: "Get warned about a rogue DHCP server or a stolen address.",
};

// -> the sentence for a place, or null when there is nothing to say.
//    host: the server's name on a server's page, null on the fleet overview.
export function purposeOf(tab, { page, host, section } = {}) {
  if (tab === "hosts") return host ? HOST[page]?.(host) ?? null : OVERVIEW;
  if (tab === "network") return NETWORK[section] ?? null;
  return TAB[tab] ?? null;
}
