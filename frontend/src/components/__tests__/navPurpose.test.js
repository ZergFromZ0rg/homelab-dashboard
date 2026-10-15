import { describe, expect, it } from "vitest";
import { HOST_PAGES } from "../hostsNav";
import { networkSections } from "../networkSections";
import { purposeOf } from "../navPurpose";

describe("purposeOf", () => {
  it("says something for every page of a server, naming the server", () => {
    for (const [page] of HOST_PAGES) {
      const text = purposeOf("hosts", { page, host: "bigboy" });
      expect(text, page).toBeTruthy();
      expect(text, page).toContain("bigboy");
    }
  });

  it("has a sentence for the fleet overview, for each network section and for the other tabs", () => {
    expect(purposeOf("hosts", { host: null })).toMatch(/wrong/);
    for (const [id] of networkSections(null)) expect(purposeOf("network", { section: id }), id).toBeTruthy();
    expect(purposeOf("network", { section: "watch" })).toBeTruthy();
    expect(purposeOf("containers")).toBeTruthy();
    expect(purposeOf("backups")).toBeTruthy();
  });

  it("is quiet about a page it has never heard of", () => {
    expect(purposeOf("hosts", { page: "nope", host: "bigboy" })).toBeNull();
    expect(purposeOf("nope")).toBeNull();
  });

  it("keeps each sentence to one short line", () => {
    for (const [page] of HOST_PAGES) expect(purposeOf("hosts", { page, host: "thinkpad" }).length).toBeLessThan(110);
  });
});
