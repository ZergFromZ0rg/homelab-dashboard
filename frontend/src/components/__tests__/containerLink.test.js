import { describe, expect, it } from "vitest";
import { containerUrl } from "../containerLink";

describe("containerUrl", () => {
  const ports = { "8053/tcp": ["8053"] };

  it("links to the published web port", () => {
    expect(containerUrl("thinkpad", ports)).toBe("http://thinkpad:8053");
  });

  it("appends the app's own path (Pi-hole's root is a 403)", () => {
    expect(containerUrl("thinkpad", ports, "/admin/")).toBe("http://thinkpad:8053/admin/");
  });

  it("has no link without a published port, whatever the path", () => {
    expect(containerUrl("thinkpad", {}, "/admin/")).toBeNull();
  });
});
