import { useCallback, useEffect, useState } from "react";

// Small persisted-state hook. Every read/write is wrapped — localStorage
// throws in private windows and when quota is hit, and we'd rather render
// with the default than crash the tab.
export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initialValue : JSON.parse(raw);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore — value still lives in React state for this session
    }
  }, [key, value]);

  const update = useCallback(
    (next) => setValue((current) => (typeof next === "function" ? next(current) : next)),
    []
  );

  return [value, update];
}
