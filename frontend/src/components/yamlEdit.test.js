// node --test: structured compose edits change only the lines they mean to.
// Fixtures are real compose files from the fleet, quirks included (a
// trailing space, a trailing blank line, long flow sequences).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addEnv, addListItem, edit, parse, readService, rebase, removeEnv, removeListItem,
  setEnv, setListItem, setScalar,
} from "./yamlEdit.js";

const fixture = (name) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

function changed(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
}

test("a no-op edit returns the file untouched", () => {
  for (const f of ["jellyfin.yml", "grafana.yml", "ai-librarian.yml"]) {
    assert.equal(edit(fixture(f), () => {}), fixture(f));
  }
});

test("changing restart touches that one line", () => {
  const before = fixture("jellyfin.yml");
  const after = edit(before, (doc) => setScalar(doc, "jellyfin", "restart", "always"));
  assert.deepEqual(changed(before, after), {
    removed: ["    restart: unless-stopped"],
    added: ["    restart: always"],
  });
  assert.ok(after.endsWith("\n\n"), "keeps the trailing blank line");
});

test("editing a port keeps its quotes", () => {
  const before = fixture("jellyfin.yml");
  const after = edit(before, (doc) => setListItem(doc, "jellyfin", "ports", 0, "8097:8096"));
  assert.deepEqual(changed(before, after), { removed: ['      - "8096:8096"'], added: ['      - "8097:8096"'] });
});

test("adding and removing env leaves the trailing-space line alone", () => {
  const before = fixture("grafana.yml");
  const added = edit(before, (doc) => addEnv(doc, "grafana", "GF_LOG_LEVEL", "warn"));
  assert.deepEqual(changed(before, added), { removed: [], added: ["      - GF_LOG_LEVEL=warn"] });
  assert.ok(added.includes("GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \n"));

  const removed = edit(added, (doc) => removeEnv(doc, "grafana", 2));
  assert.equal(removed, before);
});

test("a new list is created, and the last item removed deletes the key", () => {
  const before = fixture("jellyfin.yml");
  const withEnv = edit(before, (doc) => addEnv(doc, "jellyfin", "TZ", "America/Toronto"));
  assert.deepEqual(readService(parse(withEnv).doc, "jellyfin").environment.items, [
    { key: "TZ", value: "America/Toronto", bare: false },
  ]);
  const back = edit(withEnv, (doc) => removeEnv(doc, "jellyfin", 0));
  assert.equal(back, before);

  const volumes = edit(before, (doc) => {
    removeListItem(doc, "jellyfin", "volumes", 2);
    addListItem(doc, "jellyfin", "volumes", "/mnt/other:/other:ro");
  });
  assert.deepEqual(changed(before, volumes), {
    removed: ["      - /mnt/cooldrive/media:/media:ro"],
    added: ["      - /mnt/other:/other:ro"],
  });
});

test("flow sequences elsewhere in the file don't get reflowed", () => {
  const before = fixture("ai-librarian.yml");
  const service = Object.keys(parse(before).doc.toJSON().services)[0];
  const after = edit(before, (doc) => setScalar(doc, service, "restart", "always"));
  const { removed } = changed(before, after);
  assert.ok(removed.length <= 1, `only the restart line may change, got ${JSON.stringify(removed)}`);
});

test("map-style environment", () => {
  const text = "services:\n  app:\n    environment:\n      A: 1 # keep\n      B: two\n";
  const svc = readService(parse(text).doc, "app");
  assert.deepEqual(svc.environment, { style: "map", items: [{ key: "A", value: "1" }, { key: "B", value: "two" }] });
  const after = edit(text, (doc) => setEnv(doc, "app", 1, "B", "three"));
  assert.equal(after, "services:\n  app:\n    environment:\n      A: 1 # keep\n      B: three\n");
});

test("rebase applies a change onto text the printer would have reshaped", () => {
  const original = "a: 1   \nb: 2\n\n";
  const base = "a: 1\nb: 2\n";
  const edited = "a: 1\nb: 3\n";
  assert.equal(rebase(original, base, edited), "a: 1   \nb: 3\n\n");
});

test("long-syntax entries are shown read-only", () => {
  const text = "services:\n  app:\n    ports:\n      - target: 80\n        published: 8080\n      - \"9000:9000\"\n";
  const { ports } = readService(parse(text).doc, "app");
  assert.equal(ports.items[0].editable, false);
  assert.equal(ports.items[1].text, "9000:9000");
});
