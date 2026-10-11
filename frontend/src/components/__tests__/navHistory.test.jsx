// Back/forward between views: the hash names the view, every new view is a
// history entry, and going back shows the earlier one where you left it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildHash, parseHash, useNavHistory } from "../navHistory";

test("parses the views we write and nothing else", () => {
  expect(parseHash("#/simple")).toEqual({ mode: "simple", tab: null });
  expect(parseHash("#/advanced/containers")).toEqual({ mode: "advanced", tab: "containers" });
  expect(parseHash("#/god/terminal/")).toEqual({ mode: "god", tab: "terminal" });
  expect(parseHash("#/advanced")).toEqual({ mode: "advanced", tab: "overview" });
  expect(parseHash("")).toBeNull();
  expect(parseHash("#section")).toBeNull();
  expect(parseHash("#/constructor/files")).toBeNull();
  expect(parseHash("#/advanced/containers/extra")).toBeNull();
});

test("a tab the mode doesn't have lands on Overview", () => {
  expect(parseHash("#/advanced/system")).toEqual({ mode: "advanced", tab: "overview" });
  expect(parseHash("#/advanced/nope")).toEqual({ mode: "advanced", tab: "overview" });
  expect(parseHash("#/simple/files")).toEqual({ mode: "simple", tab: null });
});

test("builds what it parses", () => {
  for (const hash of ["#/simple", "#/advanced/files", "#/god/system"]) {
    expect(buildHash(parseHash(hash))).toBe(hash);
  }
});

// Stands in for App: a mode and a tab, buttons that change them, and the
// hook watching both.
let go;
function Harness({ initial }) {
  const [mode, setMode] = useState(initial.mode);
  const [tab, setTab] = useState(initial.tab ?? "overview");
  useEffect(() => {
    go = (m, t) => {
      setMode(m);
      if (t) setTab(t);
    };
  });
  // As in App: Simple has no tab, and the last one is kept for the way back.
  const shownTab = mode === "simple" ? null : tab;
  useNavHistory({
    mode,
    tab: shownTab,
    onPop: ({ mode: m, tab: t }) => {
      setMode(m);
      if (t) setTab(t);
    },
  });
  return <span data-testid="view">{mode}/{shownTab}</span>;
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
  render(<Harness initial={{ mode: "advanced", tab: "overview" }} />);
  expect(window.location.hash).toBe("#/advanced/overview");
  expect(window.history.length).toBe(before);
});

test("each new view is an entry, and back and forward walk them", async () => {
  render(<Harness initial={{ mode: "simple", tab: null }} />);
  expect(window.location.hash).toBe("#/simple");

  act(() => go("advanced", "overview"));
  act(() => go("advanced", "containers"));
  act(() => go("god", "system"));
  expect(window.location.hash).toBe("#/god/system");

  await back();
  expect(shown()).toBe("advanced/containers");
  expect(window.location.hash).toBe("#/advanced/containers");
  await back();
  expect(shown()).toBe("advanced/overview");
  await back();
  expect(shown()).toBe("simple/");

  await forward();
  expect(shown()).toBe("advanced/overview");
  await forward();
  await forward();
  expect(shown()).toBe("god/system");
});

test("going back doesn't add entries, and a new view after it drops the forward ones", async () => {
  render(<Harness initial={{ mode: "advanced", tab: "overview" }} />);
  act(() => go("advanced", "files"));
  act(() => go("advanced", "backups"));
  const length = window.history.length;

  await back();
  expect(window.history.length).toBe(length);

  act(() => go("advanced", "network"));
  expect(window.history.length).toBe(length);
  await forward();
  expect(shown()).toBe("advanced/network");
  await back();
  expect(shown()).toBe("advanced/files");
});

test("the same view twice is one entry", () => {
  render(<Harness initial={{ mode: "advanced", tab: "overview" }} />);
  act(() => go("advanced", "files"));
  const length = window.history.length;
  act(() => go("advanced", "files"));
  expect(window.history.length).toBe(length);
});

test("a hash typed over the top is put back", async () => {
  render(<Harness initial={{ mode: "advanced", tab: "files" }} />);
  await act(async () => {
    window.location.hash = "#nonsense";
  });
  await settle();
  expect(window.location.hash).toBe("#/advanced/files");
  expect(shown()).toBe("advanced/files");
});

test("a typed hash for another view shows it", async () => {
  render(<Harness initial={{ mode: "advanced", tab: "files" }} />);
  await act(async () => {
    window.location.hash = "#/god/system";
  });
  await settle();
  expect(shown()).toBe("god/system");
  expect(window.location.hash).toBe("#/god/system");
});

test("a new view starts at the top; going back returns to where you were", async () => {
  render(<Harness initial={{ mode: "advanced", tab: "containers" }} />);
  scrollTop(640);
  scrollTo.mockClear();

  act(() => go("advanced", "files"));
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
  scrollTop(0);

  await back();
  expect(shown()).toBe("advanced/containers");
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 640 });
});

test("switching mode on the same tab keeps the scroll position", () => {
  render(<Harness initial={{ mode: "advanced", tab: "containers" }} />);
  scrollTop(300);
  scrollTo.mockClear();
  act(() => go("god", "containers"));
  expect(window.location.hash).toBe("#/god/containers");
  expect(scrollTo).not.toHaveBeenCalled();
});
