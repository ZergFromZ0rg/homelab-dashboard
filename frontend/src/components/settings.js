import { createContext, useContext } from "react";

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

// Keep in sync with backend/service_activity._PROBES_BY_NAME and
// backend/service_activity_overrides.VALID_APPS.
export const LIVE_ACTIVITY_OVERRIDE_OPTIONS = [
  { value: "", label: "Auto-detect" },
  { value: "none", label: "Don't probe" },
  { value: "qbittorrent", label: "qBittorrent" },
  { value: "jellyfin", label: "Jellyfin" },
];

export const HOME_CARD_OPTIONS = [
  { key: "summary", label: "Summary stats" },
  { key: "attention", label: "Attention" },
  { key: "hosts", label: "Hosts" },
  { key: "quickActions", label: "Quick actions" },
  { key: "activity", label: "Recent activity" },
  { key: "todo", label: "To-do" },
];

export const DEFAULT_HOME_CARDS = Object.fromEntries(
  HOME_CARD_OPTIONS.map((c) => [c.key, true])
);

export const DEFAULT_SETTINGS = {
  graphWindowMinutes: 30,
  heartbeatWindowMinutes: 120,
  showContainerUptime: true,
  showLiveActivity: true,
  homeCards: DEFAULT_HOME_CARDS,
  pinGroups: {},
  quickActionLinks: true,
};

export const SettingsContext = createContext(null);

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
