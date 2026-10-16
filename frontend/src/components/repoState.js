// A project's GitHub repo, as the agent reports it on each container (`repo`):
// what to say about it, and which containers share it.

const SUMMARY = {
  behind: { tone: "warn", text: "New commits on GitHub" },
  up_to_date: { tone: "ok", text: "Up to date" },
  ahead: { tone: "info", text: "Not pushed yet" },
  unknown: { tone: "none", text: "Can't check" },
  checking: { tone: "none", text: "Checking…" },
};

export const needsPull = (repo) => repo?.state === "behind";

export function repoSummary(repo) {
  const base = SUMMARY[repo?.state] ?? SUMMARY.checking;
  let title = base.text;
  if (repo?.state === "behind") title = `GitHub is at ${repo.remote_short}; this checkout is at ${repo.short}. A pull brings the new commits.`;
  if (repo?.state === "up_to_date") title = `This checkout matches ${repo.branch} on GitHub (${repo.short}).`;
  if (repo?.state === "ahead") title = `This checkout has commits that aren't on GitHub yet (${repo.short}; GitHub is at ${repo.remote_short}).`;
  if (repo?.state === "unknown") title = repo.error ? `${repo.error}.` : "Couldn't compare with GitHub.";
  return { ...base, title };
}

// GitHub's page for what changed, when there is something to look at.
export function compareUrl(repo) {
  return needsPull(repo) && repo.url && repo.short && repo.remote_short ? `${repo.url}/compare/${repo.short}...${repo.remote_short}` : null;
}

// One entry per Compose project on a host that comes from a GitHub checkout:
// { project, repo, containers, target } — target is the first container the
// agent can rebuild (the one the button acts through), or null when this host
// hasn't turned rebuilds on. Repos with news first, then by name.
export function projectRepos(containers) {
  const byProject = new Map();
  for (const c of containers || []) {
    if (!c.repo || !c.compose_project) continue;
    if (!byProject.has(c.compose_project)) byProject.set(c.compose_project, []);
    byProject.get(c.compose_project).push(c);
  }
  return [...byProject.entries()]
    .map(([project, list]) => {
      const members = [...list].sort((a, b) => a.name.localeCompare(b.name));
      return { project, repo: members[0].repo, containers: members, target: members.find((c) => c.rebuild) ?? null };
    })
    .sort((a, b) => Number(needsPull(b.repo)) - Number(needsPull(a.repo)) || a.project.localeCompare(b.project));
}

// How many repos across the fleet have something to pull — the badge on Containers.
export function reposBehind(containersByHost) {
  return Object.values(containersByHost || {}).reduce((n, list) => n + projectRepos(list).filter((p) => needsPull(p.repo)).length, 0);
}
