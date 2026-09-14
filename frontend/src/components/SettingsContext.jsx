import { useMemo } from "react";
import { useLocalStorage } from "./useLocalStorage";
import {
  SettingsContext,
  DEFAULT_SETTINGS,
  DEFAULT_HOME_CARDS,
} from "./settings";

export function SettingsProvider({ children }) {
  const [stored, setStored] = useLocalStorage(
    "homelab.siteSettings",
    DEFAULT_SETTINGS
  );

  // Merge over defaults so a settings blob saved before a new field existed
  // doesn't just lose that field — it picks up the new default instead.
  const settings = useMemo(
    () => ({
      ...DEFAULT_SETTINGS,
      ...stored,
      homeCards: { ...DEFAULT_HOME_CARDS, ...(stored?.homeCards || {}) },
      pinGroups: stored?.pinGroups || {},
    }),
    [stored]
  );

  const value = useMemo(
    () => ({
      settings,
      update: (patch) => setStored({ ...settings, ...patch }),
      reset: () => setStored(DEFAULT_SETTINGS),
    }),
    [settings, setStored]
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
