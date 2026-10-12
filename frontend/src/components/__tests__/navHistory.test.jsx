// Back/forward between views: the hash names the view, every new view is a
// history entry, and going back shows the earlier one where you left it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildHash, parseHash, useNavHistory } from "../navHistory";

test("parses the views we write and nothing else", () => {
  expect(parseHash("#/simple")).toEqual({ mode: "simple", tab: null, sub: "" });
  expect(parseHash("#/god/containers")).toEqual({ mode: "god", tab: "containers", sub: "" });
  expect(parseHash("#/god/network/")).toEqual({ mode: "god", tab: "network", sub: "" });
  expect(parseHash("#/god")).toEqual({ mode: "god", tab: "hosts", sub: "" });
  expect(parseHash("")).toBeNull();
  expect(parseHash("#section")).toBeNull();
  expect(parseHash("#/constructor/files")).toBeNull();
});

test("a page inside a tab rides along as the sub", () => {
  expect(parseHash("#/god/hosts/bigboy/storage")).toEqual({ mode: "god", tab: "hosts", sub: "bigboy/storage" });
  expect(parseHash("#/god/hosts/nuc-media")).toEqual({ mode: "god", tab: "hosts", sub: "nuc-media" });
  expect(parseHash("#/god/network/dns")).toEqual({ mode: "god", tab: "network", sub: "dns" });
  expect(parseHash("#/god/hosts/%2e%2e/x")).not.toBeNull();
});

test("the old Advanced mode and its tabs open the page that holds them now", () => {
  expect(parseHash("#/advanced/containers")).toEqual({ mode: "god", tab: "containers", sub: "" });
  expect(parseHash("#/advanced/overview")).toEqual({ mode: "god", tab: "hosts", sub: "overview" });
  expect(parseHash("#/god/files")).toEqual({ mode: "god", tab: "hosts", sub: "storage" });
  expect(parseHash("#/god/system")).toEqual({ mode: "god", tab: "hosts", sub: "summary" });
  expect(parseHash("#/god/terminal")).toEqual({ mode: "god", tab: "hosts", sub: "summary" });
  expect(parseHash("#/advanced")).toEqual({ mode: "god", tab: "hosts", sub: "" });
});

test("a tab nobody has lands on the first one", () => {
  expect(parseHash("#/god/nope")).toEqual({ mode: "god", tab: "hosts", sub: "" });
  expect(parseHash("#/simple/files")).toEqual({ mode: "simple", tab: null, sub: "" });
});

test("builds what it parses", () => {
  for (const hash of ["#/simple", "#/god/containers", "#/god/hosts/bigboy/storage", "#/god/network/dns"]) {
    expect(buildHash(parseHash(hash))).toBe(hash);
  }
});

// Stands in for App: a mode and a tab, buttons that change them, and the
// hook watching both.
let go;
function Harness({ initial }) {
  const [mode, setMode] = useState(initial.mode);
  const [tab, setTab] = useState(initial.tab ?? "hosts");
  const [sub, setSub] = useState(initial.sub ?? "");
  useEffect(() => {
    go = (m, t, p = "") => {
      setMode(m);
      if (t) setTab(t);
      setSub(p);
    };
  });
  // As in App: Simple has no tab, and the last one is kept for the way back.
  const shownTab = mode === "simple" ? null : tab;
  useNavHistory({
    mode,
    tab: shownTab,
    sub: mode === "simple" ? "" : sub,
    onPop: ({ mode: m, tab: t, sub: p }) => {
      setMode(m);
      if (t) setTab(t);
      setSub(p);
    },
  });
  return <span data-testid="view">{mode}/{shownTab}{sub && mode !== "simple" ? `/${sub}` : ""}</span>;
}

const shown = () => screen.getByTestId("view").textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const back = async () => {
  await act(async () => window.history.back());
  await settle();
};
const forward = async () => {
  await act(async () => window.history.forward());
  await settle();
};
const scrollTo = vi.fn();
const scrollTop = (y) => {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.scrollTo = scrollTo;
  scrollTo.mockClear();
  scrollTop(0);
});
afterEach(cleanup);

test("the first view takes over the entry the page opened with", () => {
  const before = window.history.length;
  render(<Harness initial={{ mode: "god", tab: "hosts", sub: "overview" }} />);
  expect(window.location.hash).toBe("#/god/hosts/overview");
  expect(window.history.length).toBe(before);
});

test("each new view is an entry, and back and forward walk them", async () => {
  render(<Harness initial={{ mode: "simple", tab: null }} />);
  expect(window.location.hash).toBe("#/simple");

  act(() => go("god", "hosts", "overview"));
  act(() => go("god", "containers"));
  act(() => go("god", "network", "dns"));
  expect(window.location.hash).toBe("#/god/network/dns");

  await back();
  expect(shown()).toBe("god/containers");
  expect(window.location.hash).toBe("#/god/containers");
  await back();
  expect(shown()).toBe("god/hosts/overview");
  await back();
  expect(shown()).toBe("simple/");

  await forward();
  expect(shown()).toBe("god/hosts/overview");
  await forward();
  await forward();
  expect(shown()).toBe("god/network/dns");
});

test("a page inside a tab is an entry of its own", async () => {
  render(<Harness initial={{ mode: "god", tab: "hosts", sub: "bigboy/summary" }} />);
  act(() => go("god", "hosts", "bigboy/storage"));
  act(() => go("god", "hosts", "thinkpad/storage"));
  expect(window.location.hash).toBe("#/god/hosts/thinkpad/storage");

  await back();
  expect(shown()).toBe("god/hosts/bigboy/storage");
  await back();
  expect(shown()).toBe("god/hosts/bigboy/summary");
});

test("going back doesn't add entries, and a new view after it drops the forward ones", async () => {
  render(<Harness initial={{ mode: "god", tab: "hosts" }} />);
  act(() => go("god", "containers"));
  act(() => go("god", "backups"));
  const length = window.history.length;

  await back();
  expect(window.history.length).toBe(length);

  act(() => go("god", "network"));
  expect(window.history.length).toBe(length);
  await forward();
  expect(shown()).toBe("god/network");
  await back();
  expect(shown()).toBe("god/containers");
});

test("the same view twice is one entry", () => {
  render(<Harness initial={{ mode: "god", tab: "hosts" }} />);
  act(() => go("god", "containers"));
  const length = window.history.length;
  act(() => go("god", "containers"));
  expect(window.history.length).toBe(length);
});

test("a hash typed over the top is put back", async () => {
  render(<Harness initial={{ mode: "god", tab: "containers" }} />);
  await act(async () => {
    window.location.hash = "#nonsense";
  });
  await settle();
  expect(window.location.hash).toBe("#/god/containers");
  expect(shown()).toBe("god/containers");
});

test("a typed hash for another view shows it", async () => {
  render(<Harness initial={{ mode: "god", tab: "containers" }} />);
  await act(async () => {
    window.location.hash = "#/god/hosts/bigboy/packets";
  });
  await settle();
  expect(shown()).toBe("god/hosts/bigboy/packets");
  expect(window.location.hash).toBe("#/god/hosts/bigboy/packets");
});

test("an old Advanced address is rewritten to where its content lives now", async () => {
  render(<Harness initial={{ mode: "god", tab: "containers" }} />);
  await act(async () => {
    window.location.hash = "#/advanced/files";
  });
  await settle();
  expect(shown()).toBe("god/hosts/storage");
  expect(window.location.hash).toBe("#/god/hosts/storage");
});

test("a new view starts at the top; going back returns to where you were", async () => {
  render(<Harness initial={{ mode: "god", tab: "containers" }} />);
  scrollTop(640);
  scrollTo.mockClear();

  act(() => go("god", "backups"));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
  scrollTop(0);

  await back();
  expect(shown()).toBe("god/containers");
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 640 });
});

test("switching page inside a tab keeps the scroll position", () => {
  render(<Harness initial={{ mode: "god", tab: "network", sub: "dns" }} />);
  scrollTop(300);
  scrollTo.mockClear();
  act(() => go("god", "network", "switch"));
  expect(window.location.hash).toBe("#/god/network/switch");
  expect(scrollTo).not.toHaveBeenCalled();
});
