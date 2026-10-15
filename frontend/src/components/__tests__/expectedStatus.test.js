import { describe, expect, it } from "vitest";
import { expectedStatus, pruneExpected, withExpected } from "../expectedStatus";

const containers = () => ({
  bigboy: [
    { id: "a1", name: "jellyfin", status: "running" },
    { id: "b2", name: "radarr", status: "running" },
  ],
  thinkpad: [{ id: "a1", name: "grafana", status: "running" }],
});

describe("expectedStatus", () => {
  it("knows what a start and a stop leave behind, and nothing for a restart", () => {
    expect(expectedStatus("stop")).toBe("exited");
    expect(expectedStatus("start")).toBe("running");
    expect(expectedStatus("restart")).toBeNull();
  });
});

describe("withExpected", () => {
  it("shows a stopped container as exited before the list catches up", () => {
    const shown = withExpected(containers(), { "bigboy-a1": { status: "exited", at: 1000 } }, 2000);
    expect(shown.bigboy[0].status).toBe("exited");
    expect(shown.bigboy[1].status).toBe("running");
  });

  it("matches by host as well as id", () => {
    const shown = withExpected(containers(), { "bigboy-a1": { status: "exited", at: 1000 } }, 2000);
    expect(shown.thinkpad[0].status).toBe("running");
  });

  it("stops overriding after the hold, so the real state wins", () => {
    const list = containers();
    expect(withExpected(list, { "bigboy-a1": { status: "exited", at: 0 } }, 60000)).toBe(list);
  });

  it("hands back the same object when the list already agrees", () => {
    const list = { bigboy: [{ id: "a1", status: "exited" }] };
    expect(withExpected(list, { "bigboy-a1": { status: "exited", at: 1000 } }, 2000)).toBe(list);
  });

  it("hands back the same object when nothing is expected", () => {
    const list = containers();
    expect(withExpected(list, {})).toBe(list);
  });
});

describe("pruneExpected", () => {
  it("drops old entries and keeps fresh ones", () => {
    const kept = pruneExpected({ old: { status: "exited", at: 0 }, fresh: { status: "running", at: 59000 } }, 60000);
    expect(Object.keys(kept)).toEqual(["fresh"]);
  });
});
