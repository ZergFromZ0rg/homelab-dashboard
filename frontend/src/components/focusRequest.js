import { useEffect, useRef } from "react";

// "Show me this host / open its files" from somewhere that doesn't own the
// card — the command palette. A request is kept until the card for that
// host picks it up, because the card may only mount after the palette
// switches to the Servers tab.

const EVENT = "homelab:focus-request";
let pending = null;

export function requestFocus(host, action = "show") {
  pending = { host, action, at: Date.now() };
  window.dispatchEvent(new CustomEvent(EVENT, { detail: pending }));
}

// Calls `handler(action)` when a request for `host` arrives, or is already
// waiting when the card mounts. Async on purpose: handlers set state.
export function useFocusRequest(host, handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    const take = (request) => {
      if (!request || request.host !== host || Date.now() - request.at > 5000) return;
      pending = null;
      setTimeout(() => ref.current(request.action), 0);
    };
    take(pending);
    const onEvent = (e) => take(e.detail);
    window.addEventListener(EVENT, onEvent);
    return () => window.removeEventListener(EVENT, onEvent);
  }, [host]);
}

// "Open this part of the Advanced overview" — the Simple page's links. Kept
// until the overview mounts and takes it, like a host request above.
const SECTION_EVENT = "homelab:section-request";
let pendingSection = null;

export function requestSection(name) {
  pendingSection = { name, at: Date.now() };
  window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: pendingSection }));
}

export function useSectionRequest(handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    const take = (request) => {
      if (!request || Date.now() - request.at > 5000) return;
      pendingSection = null;
      setTimeout(() => ref.current(request.name), 0);
    };
    take(pendingSection);
    const onEvent = (e) => take(e.detail);
    window.addEventListener(SECTION_EVENT, onEvent);
    return () => window.removeEventListener(SECTION_EVENT, onEvent);
  }, []);
}
