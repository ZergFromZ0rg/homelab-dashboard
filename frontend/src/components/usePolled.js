import { useEffect, useRef, useState } from "react";

// Fetch on mount / when `key` changes, then again every `refreshMs`.
// Keeps the last good data across a failed refresh (so a blip doesn't blank
// a widget) and never shows one key's data under another (a new weather
// location shows loading, not the old city).
export function usePolled(fetcher, key, refreshMs) {
  const [state, setState] = useState({ key, data: null, error: null });
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setState({ key, data, error: null });
      } catch (error) {
        if (!cancelled) {
          setState((s) => ({ key, data: s.key === key ? s.data : null, error: error.message }));
        }
      }
    };

    run();
    const timer = refreshMs ? setInterval(run, refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, refreshMs]);

  const current = state.key === key ? state : { data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    loading: current.data == null && current.error == null,
  };
}
