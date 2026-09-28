// A clicked briefing action follows its real job to an end state.
import { afterEach, expect, test, vi } from "vitest";
import { advance, startRun } from "../actionRuns";

const reply = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());

const running = (type, extra = {}) => ({ id: `${type}:bigboy`, type, host: "bigboy", title: "t", startedAt: 1000, state: "running", ...extra });

test("an OS upgrade stays running until apt finishes, then reports its exit", async () => {
  const fetch = vi.fn()
    .mockReturnValueOnce(reply({ running: true, log: "Unpacking…" }))
    .mockReturnValueOnce(reply({ running: false, exit_code: 100, log: "E: dpkg was interrupted" }));
  vi.stubGlobal("fetch", fetch);

  const run = running("os_upgrade");
  expect(await advance(run)).toBe(run);
  const ended = await advance(run, { now: 5000 });
  expect(ended).toMatchObject({ state: "failed", note: "apt exited 100", endedAt: 5000 });
  expect(ended.detail).toContain("dpkg was interrupted");
  expect(fetch).toHaveBeenCalledWith("/api/hosts/bigboy/os-updates/status");
});

test("a container update follows its job; a rollback is a failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(reply({ state: "rolled_back", results: { jellyfin: "rolled_back" } })));
  const ended = await advance(running("container_updates", { jobId: "j1" }));
  expect(ended).toMatchObject({ state: "failed", note: "Rolled back" });
  expect(ended.detail).toContain("jellyfin");
});

test("a reboot is done once the host has been seen down and back", async () => {
  const run = running("reboot");
  const down = await advance(run, { machines: { bigboy: { online: false } }, now: 2000 });
  expect(down).toMatchObject({ state: "running", sawDown: true });
  expect(await advance(down, { machines: { bigboy: { online: true } }, now: 3000 })).toMatchObject({ state: "done", note: "Back up" });
});

test("a reboot still offline after 15 minutes is reported, not spun forever", async () => {
  const run = running("reboot", { sawDown: true });
  const ended = await advance(run, { machines: { bigboy: { online: false } }, now: 1000 + 16 * 60 * 1000 });
  expect(ended).toMatchObject({ state: "failed", note: "Not back" });
});

test("a start the server refuses becomes a failed status, not a lost error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(reply({ detail: "agent unreachable" }, 502)));
  const run = await startRun({ id: "os_upgrade:bigboy", type: "os_upgrade", host: "bigboy", title: "t", action: { url: "/x" } });
  expect(run).toMatchObject({ state: "failed", note: "Didn't start", detail: "agent unreachable" });
});
