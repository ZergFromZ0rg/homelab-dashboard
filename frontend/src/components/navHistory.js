import { useLayoutEffect, useRef } from "react";

// Back and forward between the views of the dashboard (the trackpad swipe,
// ⌘[ / ⌘], the browser buttons). A view is a mode, a tab and, inside the
// tab, a page — kept in the URL hash: `#/simple`, `#/god/containers`,
// `#/god/hosts/bigboy/storage` — so it also survives a reload and can be
// bookmarked. A hash needs nothing from nginx or `tailscale serve`, and
// AuthGate's https redirect already carries it.

// The tabs each mode shows, in tab-bar order. Simple has none.
const TABS = {
  simple: [],
  god: ["hosts", "containers", "network", "backups"],
};

// Addresses from before the two-mode layout still open something sensible:
// the old tab becomes the new tab and page that hold its content, and the
// "advanced" mode is God.
const LEGACY_TAB = {
  overview: ["hosts", "overview"],
  servers: ["hosts", "overview"],
  files: ["hosts", "storage"],
  system: ["hosts", "summary"],
  terminal: ["hosts", "summary"],
};

// "#/god/hosts/bigboy/storage" -> { mode, tab, sub: "bigboy/storage" }; null
// when it isn't one of ours. A tab the mode doesn't have becomes the first
// tab rather than a blank page. `sub` is whatever the tab makes of it.
export function parseHash(hash) {
  const match = /^#\/([a-z]+)(?:\/([a-z]+))?(?:\/([A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*))?\/?$/.exec(hash || "");
  if (!match) return null;
  const mode = match[1] === "advanced" ? "god" : match[1];
  if (!Object.hasOwn(TABS, mode)) return null;
  if (mode === "simple") return { mode, tab: null, sub: "" };
  const [, , tab, rest] = match;
  if (TABS[mode].includes(tab)) return { mode, tab, sub: decodeSub(rest) };
  const legacy = Object.hasOwn(LEGACY_TAB, tab) ? LEGACY_TAB[tab] : null;
  return legacy ? { mode, tab: legacy[0], sub: legacy[1] } : { mode, tab: TABS[mode][0], sub: "" };
}

function decodeSub(rest) {
  if (!rest) return "";
  try {
    return rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

export function buildHash({ mode, tab, sub }) {
  if (mode === "simple") return "#/simple";
  const tail = sub ? `/${sub.split("/").map(encodeURIComponent).join("/")}` : "";
  return `#/${mode}/${tab}${tail}`;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Keeps history in step with the view on screen: a new view pushes an entry,
// and back/forward hands the entry's view to `onPop({ mode, tab, sub })`. The
// view is not saved as the mode preference, so a swipe in this window never
// moves the others (they follow the mode setting, not the history).
//
// Each entry also remembers how far the page was scrolled, so going back
// lands where you were instead of at the top.
export function useNavHistory({ mode, tab, sub = "", onPop }) {
  const shown = useRef({ mode, tab, sub });
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
      if (target.mode === shown.current.mode && target.tab === shown.current.tab && target.sub === shown.current.sub) {
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
    shown.current = { mode, tab, sub };
    const want = buildHash({ mode, tab, sub });
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
  }, [mode, tab, sub]);
}
