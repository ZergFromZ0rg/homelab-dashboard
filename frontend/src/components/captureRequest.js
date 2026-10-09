import { useEffect, useRef } from "react";

// "Capture this container's traffic" from a container row, which doesn't own
// the Network tab. The request waits until the tab and then the Packets view
// have mounted and taken it — the same pattern as focusRequest.

const NAVIGATE = "homelab:navigate";
const REQUEST = "homelab:capture-request";
let pending = null;

export function requestContainerCapture(host, container) {
  pending = { host, container, at: Date.now() };
  window.dispatchEvent(new CustomEvent(NAVIGATE, { detail: { target: "network" } }));
  window.dispatchEvent(new CustomEvent(REQUEST, { detail: pending }));
}

const fresh = (request) => request && Date.now() - request.at < 8000;

// The Network tab: switch to the Packets view of the requested host. The
// request is left in place for the view itself to read.
export function useCaptureRequest(handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    const take = (request) => {
      if (fresh(request)) setTimeout(() => ref.current(request), 0);
    };
    take(pending);
    const onEvent = (e) => take(e.detail);
    window.addEventListener(REQUEST, onEvent);
    return () => window.removeEventListener(REQUEST, onEvent);
  }, []);
}

// The Packets view: the container to preselect for this host, once.
export function takeCaptureTarget(host) {
  if (!fresh(pending) || pending.host !== host) return null;
  const { container } = pending;
  pending = null;
  return container;
}

// App: lets a component far from the tab bar ask to go to a tab.
export function onNavigateRequest(handler) {
  const listener = (e) => handler(e.detail.target);
  window.addEventListener(NAVIGATE, listener);
  return () => window.removeEventListener(NAVIGATE, listener);
}
