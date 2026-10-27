import { useEffect, useState } from "react";
import { fetchRecovery } from "./backupsApi";

// The recovery report of every host: { [host]: { data, error } }, each filling in
// as that host's agent answers (the first ask can take a few seconds while it
// measures its volumes) and kept across a failed refresh, so a blip doesn't blank
// a panel. The agent caches its sizes for five minutes, so a refresh every two
// asks it to do no new work most of the time.
const REFRESH_MS = 120_000;

export function useRecoveries(hosts, refreshMs = REFRESH_MS) {
  const key = hosts.join("|");
  const [state, setState] = useState({ key, byHost: {} });

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split("|") : [];

    const settle = (host, patch) => {
      if (cancelled) return;
      setState((s) => {
        const byHost = s.key === key ? s.byHost : {};
        return { key, byHost: { ...byHost, [host]: { data: byHost[host]?.data ?? null, error: null, ...patch } } };
      });
    };

    const ask = () =>
      list.forEach((host) =>
        fetchRecovery(host).then(
          (data) => settle(host, { data, error: null }),
          (error) => settle(host, { error: error.message })
        )
      );

    ask();
    const timer = setInterval(ask, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, refreshMs]);

  return state.key === key ? state.byHost : {};
}
