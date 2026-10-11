import { describe, expect, it } from "vitest";
import { containerLink, containerUrl, linkProblem } from "../containerLink";

const web = (over = {}) => ({ port: 8053, scheme: "http", path: "/admin/", status: 302, ok: true, host_rejected: false, ...over });

describe("containerLink", () => {
  it("uses where the agent found the web UI, path included", () => {
    expect(containerLink("thinkpad", { ports: {}, web: web() })).toBe("http://thinkpad:8053/admin/");
  });

  it("keeps the scheme the agent found", () => {
    expect(containerLink("bigboy", { web: web({ scheme: "https", port: 9443, path: "/" }) })).toBe("https://bigboy:9443");
  });

  it("trusts the agent's null: it looked and there is no web UI", () => {
    expect(containerLink("thinkpad", { ports: { "6881/tcp": ["6881"] }, web: null })).toBeNull();
  });

  it("falls back to the published ports when the agent sent no answer", () => {
    expect(containerLink("thinkpad", { ports: { "80/tcp": ["8081"] } })).toBe("http://thinkpad:8081");
    expect(containerLink("thinkpad", { ports: {} })).toBeNull();
  });
});

describe("containerUrl", () => {
  it("prefers a common web port over the torrent port", () => {
    expect(containerUrl("bigboy", { "6881/tcp": ["6881"], "8080/tcp": ["8080"] })).toBe("http://bigboy:8080");
  });
});

describe("linkProblem", () => {
  it("is quiet when the link works or the agent hasn't said", () => {
    expect(linkProblem("thinkpad", { web: web() })).toBeNull();
    expect(linkProblem("thinkpad", { ports: {} })).toBeNull();
    expect(linkProblem("thinkpad", { web: null })).toBeNull();
  });

  it("names an app that refuses the node's name", () => {
    expect(linkProblem("thinkpad", { web: web({ ok: false, host_rejected: true, status: 400 }) })).toMatch(/refuses the name "thinkpad"/);
  });

  it("reports any other failing status", () => {
    expect(linkProblem("thinkpad", { web: web({ ok: false, status: 500 }) })).toBe("Answered 500");
  });
});
