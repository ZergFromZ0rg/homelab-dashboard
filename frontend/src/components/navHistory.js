import { useLayoutEffect, useRef } from "react";

// Back and forward between the views of the dashboard (the trackpad swipe,
// ⌘[ / ⌘], the browser buttons). A view is a mode plus a tab, kept in the
// URL hash — `#/simple`, `#/advanced/containers` — so it also survives a
// reload and can be bookmarked. A hash needs nothing from nginx or
// `tailscale serve`, and AuthGate's https redirect already carries it.

// The tabs each mode shows, in tab-bar order. Simple has none.
const TABS = {
  simple: [],
  advanced: ["overview", "containers", "files", "backups", "network"],
  god: ["overview", "containers", "files", "backups", "network", "system", "terminal"],
};

// "#/advanced/containers" -> { mode, tab }; null when it isn't one of ours.
// A tab the mode doesn't have (a bookmark of #/advanced/system) becomes
// Overview rather than a blank page.
export function parseHash(hash) {
  const match = /^#\/([a-z]+)(?:\/([a-z]+))?\/?$/.exec(hash || "");
  if (!match || !Object.hasOwn(TABS, match[1])) return null;
  const [, mode, tab] = match;
  if (mode === "simple") return { mode, tab: null };
  return { mode, tab: TABS[mode].includes(tab) ? tab : "overview" };
}

export function buildHash({ mode, tab }) {
  return mode === "simple" ? "#/simple" : `#/${mode}/${tab}`;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Keeps history in step with the view on screen: a new view pushes an entry,
// and back/forward hands the entry's view to `onPop({ mode, tab })`. The
// view is not saved as the mode preference, so a swipe in this window never
// moves the others (they follow the mode setting, not the history).
//
// Each entry also remembers how far the page was scrolled, so going back
// lands where you were instead of at the top.
export function useNavHistory({ mode, tab, onPop }) {
  const shown = useRef({ mode, tab });
  const entry = useRef(null);
  const scrolls = useRef(new Map());
  const pending = useRef(null);
  const onPopRef = useRef(onPop);
  const fresh = useRef(true);
  const lastView = useRef(mode === "simple" ? "simple" : tab);

  useLayoutEffect(() => {
    onPopRef.current = onPop;
  });

  // The browser would restore scroll before the view has rendered.
  useLayoutEffect(() => {
    const before = window.history.scrollRestoration;
    try {
      window.history.scrollRestoration = "manual";
    } catch {
      // not settable: the restore below still wins on the next frame
    }
    const onScroll = () => {
      if (entry.current) scrolls.current.set(entry.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      try {
        window.history.scrollRestoration = before;
      } catch {
        // see above
      }
    };
  }, []);

  useLayoutEffect(() => {
    const onPopState = (e) => {
      const target = parseHash(window.location.hash);
      if (!target) {
        // Typed some other hash: put the real one back.
        window.history.replaceState({ nav: entry.current }, "", buildHash(shown.current));
        return;
      }
      const id = e.state?.nav ?? newId();
      const canonical = buildHash(target);
      if (id !== e.state?.nav || canonical !== window.location.hash) {
        window.history.replaceState({ nav: id }, "", canonical);
      }
      entry.current = id;
      const y = scrolls.current.get(id) ?? 0;
      if (target.mode === shown.current.mode && target.tab === shown.current.tab) {
        window.scrollTo({ top: y });
        return;
      }
      pending.current = y;
      onPopRef.current(target);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useLayoutEffect(() => {
    shown.current = { mode, tab };
    const want = buildHash({ mode, tab });
    const view = mode === "simple" ? "simple" : tab;
    try {
      if (fresh.current) {
        // First view: it takes over the entry the page opened with.
        fresh.current = false;
        entry.current = window.history.state?.nav ?? newId();
        window.history.replaceState({ nav: entry.current }, "", want);
      } else if (window.location.hash !== want) {
        // The entry we leave keeps the position the scroll listener last saw
        // (reading it here would be after the new view had laid out).
        entry.current = newId();
        window.history.pushState({ nav: entry.current }, "", want);
      }
    } catch {
      // History is locked down (some embedded views): navigation still works, just without entries.
    }
    if (pending.current !== null) {
      window.scrollTo({ top: pending.current });
      pending.current = null;
    } else if (lastView.current !== view) {
      // A new view starts at its top; keeping the old scroll offset dropped you
      // mid-page (or past the end) of a tab you hadn't read yet.
      window.scrollTo({ top: 0 });
    }
    lastView.current = view;
  }, [mode, tab]);
}
