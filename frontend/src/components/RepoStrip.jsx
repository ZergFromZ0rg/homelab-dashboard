import Icon from "./Icon";
import { RebuildNote } from "./RebuildButton";
import { compareUrl, needsPull, projectRepos, repoSummary } from "./repoState";
import { useRebuild } from "./useRebuild";

// The GitHub repos behind a host's containers: which checkout each project was
// built from, whether GitHub has moved on, and the button that pulls and
// redeploys it. Detected from the containers themselves (Compose project →
// its folder → that folder's git remote), so there is nothing to set up.

function RepoLine({ host, entry }) {
  const { project, repo, containers, target } = entry;
  const rebuild = useRebuild(host, target, target?.rebuild);
  const summary = repoSummary(repo);
  const behind = needsPull(repo);
  const changes = compareUrl(repo);
  const names = containers.map((c) => c.name).join(", ");

  return (
    <li className={`repo-line ${behind ? "repo-line--behind" : ""}`}>
      <Icon name="branch" size={16} />
      <div className="repo-id">
        <a href={repo.url} target="_blank" rel="noopener noreferrer" title={`Open ${repo.url}`}>
          {repo.owner}/{repo.name}
        </a>
        {repo.branch && <span className="chip">{repo.branch}</span>}
        <span className="repo-sha" title={repo.subject || undefined}>
          {repo.short}
        </span>
      </div>

      <span className="repo-what" title={`${project}: ${names}`}>
        {containers.length} container{containers.length === 1 ? "" : "s"} · {repo.subject || project}
      </span>

      <span className={`status-pill status-pill--${summary.tone === "warn" ? "warn" : summary.tone === "ok" ? "ok" : summary.tone === "info" ? "info" : "none"}`} title={summary.title}>
        {summary.text}
      </span>

      {behind && changes && (
        <a className="repo-changes" href={changes} target="_blank" rel="noopener noreferrer" title="See on GitHub what changed">
          {repo.short} → {repo.remote_short} ↗
        </a>
      )}
      {repo.dirty && (
        <span className="repo-dirty" title="This folder on the host has changes that aren't committed. A pull stops if they conflict with the new commits.">
          uncommitted changes
        </span>
      )}

      <span className="repo-end">
        <RebuildNote note={rebuild.note} onDismiss={rebuild.dismiss} />
        {target ? (
          <button
            type="button"
            className={`btn btn--sm ${behind ? "btn--primary" : ""}`}
            disabled={rebuild.running}
            title={rebuild.title}
            onClick={rebuild.run}
          >
            {rebuild.running ? "Redeploying…" : behind ? "Pull & redeploy" : "Redeploy"}
          </button>
        ) : (
          <span className="repo-off" title="Turn on REBUILD_ENABLED=1 in this host's agent .env to pull and redeploy from here">
            rebuilds off
          </span>
        )}
      </span>
    </li>
  );
}

function RepoStrip({ host, containers }) {
  const entries = projectRepos(containers);
  if (entries.length === 0) return null;

  return (
    <ul className="repo-strip" aria-label={`Source repos on ${host}`}>
      {entries.map((entry) => (
        <RepoLine key={entry.project} host={host} entry={entry} />
      ))}
    </ul>
  );
}

export default RepoStrip;
