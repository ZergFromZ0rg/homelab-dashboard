import Card from "./Card";
import { formatAge } from "./format";
import { hostColor } from "./hostColor";
import { composeProjects } from "./projects";
import { useNow } from "./useNow";

// What is being run, as projects: one line each — its name and host, how many of
// its containers are up, a mark if newer images are waiting, and how long ago it
// was last (re)started, so what you redeployed today sits at the top. Anything
// that needs a look comes first.
function ProjectsCard({ containers, ready, onOpen }) {
  const now = useNow(60000).getTime();
  const projects = composeProjects(containers);

  return (
    <Card title="Projects" count={projects.length || null} className="sh-projects sh-fill">
      {!ready ? (
        <p className="sh-empty">Waiting for the first update…</p>
      ) : projects.length === 0 ? (
        <p className="sh-empty">No compose projects reported yet.</p>
      ) : (
        <ul className="sh-project-list">
          {projects.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                className="sh-project"
                title={`${p.name} on ${p.host}: ${p.containers.join(", ")}`}
                onClick={() => onOpen(p.name)}
              >
                <span className={`status-dot status-dot--${p.tone}`} />
                <span className="sh-project-name">{p.name}</span>
                <span className="sh-project-host" style={{ color: hostColor(p.host) }}>{p.host}</span>
                {p.updates > 0 && <span className="sh-project-up" title={`${p.updates} newer image${p.updates === 1 ? "" : "s"}`}>↑{p.updates}</span>}
                <span className="sh-project-count">{p.running}/{p.total}</span>
                <span className="sh-project-age">{p.newest != null ? formatAge((now - p.newest) / 1000) : "—"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default ProjectsCard;
