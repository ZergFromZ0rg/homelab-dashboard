import { createContext, useContext } from "react";
import { HIGH_RESTART_COUNT } from "./containerSort";

// Display-only preferences (graph window, which home cards show, pin
// groupings, ...). Unlike pins/todos these never leave the browser — no
// reason to sync a layout preference across devices — so a single
// localStorage blob is enough. Split from SettingsContext.jsx (the
// provider component) so react-refresh doesn't choke on a file that
// exports both a component and plain values.

export const GRAPH_WINDOW_OPTIONS = [
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
];

// Keep in sync with backend/live_history.HEARTBEAT_BUCKET_SECONDS and
// WINDOW_SECONDS — each option here must divide evenly into a whole
// number of native buckets so Heartbeat.jsx can merge them cleanly.
export const HEARTBEAT_WINDOW_OPTIONS = [
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
];

export const HOME_CARD_OPTIONS = [
  { key: "summary", label: "Summary stats" },
  { key: "attention", label: "Attention" },
  { key: "hosts", label: "Hosts (compact)" },
  { key: "services", label: "Services" },
  { key: "quickActions", label: "Quick actions" },
  { key: "activity", label: "Recent activity" },
];

export const PERSONAL_CARD_OPTIONS = [
  { key: "greeting", label: "Greeting" },
  { key: "todo", label: "To-do" },
  { key: "weather", label: "Weather" },
  { key: "word", label: "Word of the day" },
  { key: "links", label: "Quick links" },
];

export const DEFAULT_PERSONAL_CARDS = Object.fromEntries(
  PERSONAL_CARD_OPTIONS.map((c) => [c.key, true])
);

export const DEFAULT_HOME_CARDS = Object.fromEntries(
  HOME_CARD_OPTIONS.map((c) => [c.key, true])
);

export const DEFAULT_SETTINGS = {
  siteTitle: "System Dashboard",
  siteSubtitle: "Zerg Homelab",
  displayName: "",
  weatherLocation: null, // { name, region, country, lat, lon }
  temperatureUnits: "metric", // "metric" | "imperial"
  links: [], // [{ id, label, url }]
  personalCards: DEFAULT_PERSONAL_CARDS,
  graphWindowMinutes: 30,
  heartbeatWindowMinutes: 120,
  showContainerUptime: true,
  showLiveActivity: true,
  homeCards: DEFAULT_HOME_CARDS,
  pinGroups: {},
  quickActionLinks: true,
  highRestartCount: HIGH_RESTART_COUNT,
};

export const SettingsContext = createContext(null);

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
