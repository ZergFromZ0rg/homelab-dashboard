import { useEffect, useRef } from "react";

// "Capture this container's traffic" from a container row, which doesn't own
// the Packets page. The app opens that page of the container's host; the request
// waits until the page has mounted and taken it.

const NAVIGATE = "homelab:navigate";
const REQUEST = "homelab:capture-request";
let pending = null;

export function requestContainerCapture(host, container) {
  pending = { host, container, at: Date.now() };
  window.dispatchEvent(new CustomEvent(NAVIGATE, { detail: { target: "packets", host } }));
  window.dispatchEvent(new CustomEvent(REQUEST, { detail: pending }));
}

const fresh = (request) => request && Date.now() - request.at < 8000;

// The container requested for this host, once; null if there is none, it is for
// another host, or it has gone stale.
export function takeCaptureTarget(host) {
  if (!fresh(pending) || pending.host !== host) return null;
  const { container } = pending;
  pending = null;
  return container;
}

// The Packets view: preselect the requested container, whether the request was
// waiting when the view mounted or arrives while it is already open (clicking
// a container row while looking at that host's packets).
export function useCaptureTarget(host, handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    const take = () => {
      const container = takeCaptureTarget(host);
      if (container) setTimeout(() => ref.current(container), 0);
    };
    take();
    window.addEventListener(REQUEST, take);
    return () => window.removeEventListener(REQUEST, take);
  }, [host]);
}

// App: lets a component far from the tab bar ask to go somewhere
// (handler(target, { host })).
export function onNavigateRequest(handler) {
  const listener = (e) => handler(e.detail.target, { host: e.detail.host });
  window.addEventListener(NAVIGATE, listener);
  return () => window.removeEventListener(NAVIGATE, listener);
}

// For tests: forget any waiting request.
export function resetCaptureRequests() {
  pending = null;
}
