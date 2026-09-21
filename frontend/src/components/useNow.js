import { useEffect, useState } from "react";

// The current time as a Date, re-read every `intervalMs` — for "12s ago"
// style labels that must keep moving between data updates.
export function useNow(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
