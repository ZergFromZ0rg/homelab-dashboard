import { useState } from "react";
import Card from "./Card";
import { useNow } from "./useNow";

// Weeks start on Monday, like the reference board — JS getDay() is
// Sunday-first, so every index shifts by one.
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

// Every cell the month needs, including the days either side that fill out
// its first and last week. Trailing weeks that belong entirely to the next
// month are left off, so a short month doesn't leave a blank row.
function monthCells(year, month) {
  const offset = mondayIndex(new Date(year, month, 1));
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);

  return Array.from({ length: weeks * 7 }, (_, i) =>
    new Date(year, month, i - offset + 1)
  );
}

function CalendarCard() {
  // A minute is plenty — the only thing that moves is which day is "today".
  const now = useNow(60000);
  // null = follow the clock; a {year, month} = the user paged away from it.
  const [viewing, setViewing] = useState(null);

  const year = viewing ? viewing.year : now.getFullYear();
  const month = viewing ? viewing.month : now.getMonth();
  const cells = monthCells(year, month);

  const shift = (by) => {
    const next = new Date(year, month + by, 1);
    const isNow =
      next.getFullYear() === now.getFullYear() &&
      next.getMonth() === now.getMonth();
    setViewing(isNow ? null : { year: next.getFullYear(), month: next.getMonth() });
  };

  return (
    <Card
      title={new Date(year, month, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })}
      actions={
        <div className="calendar-nav">
          {viewing && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setViewing(null)}
            >
              Today
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={() => shift(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={() => shift(1)}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      }
    >
      <div className="calendar">
        {WEEKDAYS.map((day) => (
          <span key={day} className="calendar-weekday">
            {day}
          </span>
        ))}

        {cells.map((date) => {
          const outside = date.getMonth() !== month;
          const weekend = mondayIndex(date) >= 5;
          const today = sameDay(date, now);

          return (
            <span
              key={date.toDateString()}
              className={[
                "calendar-day",
                outside ? "calendar-day--outside" : "",
                weekend ? "calendar-day--weekend" : "",
                today ? "calendar-day--today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-current={today ? "date" : undefined}
            >
              {date.getDate()}
            </span>
          );
        })}
      </div>
    </Card>
  );
}

export default CalendarCard;
