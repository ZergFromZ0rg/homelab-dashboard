import { useNow } from "./useNow";
import { useSettings } from "./settings";

function partOfDay(hour) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Time-aware hello with the date and clock, plus a one-line read on the
// fleet so the Personal tab still tells you if something is on fire.
function Greeting({ overview, openTodos }) {
  const {
    settings: { displayName },
  } = useSettings();
  const now = useNow(15000);

  const issues = overview.issues.length;
  const name = displayName.trim();

  return (
    <div className="greeting">
      <div>
        <h2 className="greeting-hello">
          {partOfDay(now.getHours())}
          {name ? `, ${name}` : ""}
        </h2>
        <p className="greeting-date">
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
        <p className="greeting-status">
          <span className={`status-dot status-dot--${overview.ok ? "ok" : "warn"}`} />
          {overview.ok
            ? "All systems operational"
            : `${issues} issue${issues === 1 ? "" : "s"} need${issues === 1 ? "s" : ""} attention`}
          {openTodos > 0 && ` · ${openTodos} open to-do${openTodos === 1 ? "" : "s"}`}
        </p>
      </div>
      <div className="greeting-clock">
        {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </div>
    </div>
  );
}

export default Greeting;
