import "./fleet.css";
import { containerStrip, failedServices } from "./hostHealth";
import { useSettings } from "./settings";

const SHOWN_NAMES = 3;

// The two things a host's Health page answers before any graph: are its
// containers all right, and has anything on the machine failed? One dot per
// container, the failing ones named; the failed services named. Each name opens
// where it can be dealt with.
function HostStatusBand({ machine, containers, onOpenContainers, onOpenServices }) {
  const {
    settings: { highRestartCount },
  } = useSettings();
  if (!machine.online) return null;

  const strip = containerStrip(containers, highRestartCount);
  const failed = failedServices(machine);
  const names = strip.problems.slice(0, SHOWN_NAMES);
  const moreNames = strip.problems.length - names.length;

  return (
    <div className={`hh-band ${failed ? "" : "hh-band--one"}`}>
      <section className="hh-cell" aria-label="Containers">
        <h3>Containers</h3>
        {strip.total === 0 ? (
          <span className="hh-quiet">none on this host</span>
        ) : (
          <>
            <strong>
              {strip.running}/{strip.total} running
            </strong>
            <span className="hh-dots" role="img" aria-label={`${strip.running} of ${strip.total} containers running`}>
              {strip.items.map((item) => (
                <i key={item.id} className={`hh-dot hh-dot--${item.tone}`} title={item.title} />
              ))}
            </span>
            {names.map((p) => (
              <button
                key={p.id}
                type="button"
                className="hh-name hh-name--bad"
                title={`Find ${p.name} in Containers`}
                onClick={() => onOpenContainers(p.name)}
              >
                {p.name} <em>{p.reason}</em>
              </button>
            ))}
            {moreNames > 0 && <span className="hh-quiet">+{moreNames} more</span>}
          </>
        )}
        <button type="button" className="hh-open" onClick={() => onOpenContainers()}>
          Open →
        </button>
      </section>

      {failed && (
        <section className="hh-cell" aria-label="Services">
          <h3>Services</h3>
          {failed.length === 0 ? (
            <span className="hh-quiet">none failed</span>
          ) : (
            <>
              <strong className="hh-tone--bad">{failed.length} failed</strong>
              {failed.slice(0, SHOWN_NAMES).map((s) => (
                <button
                  key={s.unit}
                  type="button"
                  className="hh-name hh-name--bad"
                  title={`${s.unit} — see it on the Services page`}
                  onClick={onOpenServices}
                >
                  {s.label}
                </button>
              ))}
              {failed.length > SHOWN_NAMES && <span className="hh-quiet">+{failed.length - SHOWN_NAMES} more</span>}
            </>
          )}
          <button type="button" className="hh-open" onClick={onOpenServices}>
            Open →
          </button>
        </section>
      )}
    </div>
  );
}

export default HostStatusBand;
