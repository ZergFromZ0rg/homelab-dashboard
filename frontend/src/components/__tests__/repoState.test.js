import { describe, expect, it } from "vitest";
import { compareUrl, needsPull, projectRepos, repoSummary, reposBehind } from "../repoState";

const repo = (over = {}) => ({
  owner: "ZergFromZ0rg", name: "ai-librarian", url: "https://github.com/ZergFromZ0rg/ai-librarian",
  branch: "main", short: "f4ef1c4", remote_short: "22ee733", state: "behind", ...over,
});
const c = (name, project, over = {}) => ({ name, compose_project: project, repo: repo(), rebuild: { project }, ...over });

describe("repoSummary", () => {
  it("says what each state means in plain words", () => {
    expect(repoSummary(repo()).text).toBe("New commits on GitHub");
    expect(repoSummary(repo({ state: "up_to_date" })).text).toBe("Up to date");
    expect(repoSummary(repo({ state: "ahead" })).text).toBe("Not pushed yet");
    expect(repoSummary(repo({ state: "unknown", error: "private repo" })).title).toContain("private repo");
  });

  it("warns only for a repo with news", () => {
    expect(repoSummary(repo()).tone).toBe("warn");
    expect(repoSummary(repo({ state: "up_to_date" })).tone).toBe("ok");
  });

  it("treats a missing repo as still being checked", () => {
    expect(repoSummary(undefined).text).toBe("Checking…");
  });
});

describe("compareUrl", () => {
  it("links to what changed only when something did", () => {
    expect(compareUrl(repo())).toBe("https://github.com/ZergFromZ0rg/ai-librarian/compare/f4ef1c4...22ee733");
    expect(compareUrl(repo({ state: "up_to_date" }))).toBeNull();
  });
});

describe("projectRepos", () => {
  it("groups containers by project, ignoring ones with no repo", () => {
    const list = projectRepos([c("ui", "app"), c("db", "app"), { name: "node-exporter", compose_project: null }, { name: "plain", compose_project: "x" }]);
    expect(list).toHaveLength(1);
    expect(list[0].containers.map((x) => x.name)).toEqual(["db", "ui"]);
  });

  it("acts through a container the agent can rebuild, or none", () => {
    expect(projectRepos([c("a", "p", { rebuild: null }), c("b", "p")])[0].target.name).toBe("b");
    expect(projectRepos([c("a", "p", { rebuild: null })])[0].target).toBeNull();
  });

  it("puts repos with news first", () => {
    const list = projectRepos([c("z", "zeta", { repo: repo({ state: "behind" }) }), c("a", "alpha", { repo: repo({ state: "up_to_date" }) })]);
    expect(list.map((p) => p.project)).toEqual(["zeta", "alpha"]);
  });
});

describe("reposBehind", () => {
  it("counts repos, not the containers that share one", () => {
    expect(reposBehind({ bigboy: [c("a", "p"), c("b", "p"), c("c", "q", { repo: repo({ state: "up_to_date" }) })], thinkpad: [c("d", "r")] })).toBe(2);
    expect(needsPull(repo())).toBe(true);
  });
});
