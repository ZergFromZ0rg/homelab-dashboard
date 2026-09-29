import { useEffect, useState } from "react";
import { useSettings } from "./settings";
import SummaryRow from "./SummaryRow";

function partOfDay(hour) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// The current time, re-read on each minute boundary so the clock turns
// over with the system clock instead of up to a polling interval late.
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      const d = new Date();
      const wait = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50;
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, wait);
    };
    // Back from sleep or a background tab: timers ran late, catch up now.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      setNow(new Date());
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  return now;
}

// The Simple page's first line: hello and the date, the fleet's headline
// numbers, and the clock. Each half follows its own Settings switch
// (Greeting under personal cards, Summary stats under home cards).
function Greeting({ overview, machines, containers, backups, ready = true, showHello = true, showStats = true }) {
  const {
    settings: { displayName },
  } = useSettings();
  const now = useMinute();
  const name = displayName.trim();

  if (!showHello && !showStats) return null;

  return (
    <header className="simple-head">
      {showHello && (
        <div className="simple-hello">
          <h2>
            {partOfDay(now.getHours())}
            {name ? `, ${name}` : ""}
          </h2>
          <span className="simple-date">
            {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
      )}
      {showStats && (
        <SummaryRow overview={overview} machines={machines} containers={containers} backups={backups} ready={ready} />
      )}
      {showHello && (
        <time className="simple-clock" dateTime={now.toISOString()}>
          {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </time>
      )}
    </header>
  );
}

export default Greeting;
