import CalendarCard from "./CalendarCard";
import Card from "./Card";
import Greeting from "./Greeting";
import LinksCard from "./LinksCard";
import NotesCard from "./NotesCard";
import TodoList from "./TodoList";
import WeatherCard from "./WeatherCard";
import WordCard from "./WordCard";
import { useSettings } from "./settings";

// The non-fleet stuff: to-dos, weather, a word, bookmarks. One even grid —
// three across, every card in a row the same height — rather than two
// columns of different lengths. Each card can be switched off in Settings;
// the grid reflows around whatever's left.
function PersonalTab({ overview, todos, onSetTodos, openTodos, checks = [] }) {
  const {
    settings: { personalCards: show },
  } = useSettings();

  const anyCard =
    show.todo || show.notes || show.weather || show.word || show.links || show.calendar;

  return (
    <section className="personal-tab">
      {show.greeting && <Greeting overview={overview} openTodos={openTodos} />}

      {anyCard ? (
        <div className="personal-grid">
          {show.todo && (
            <Card title="To-do" count={openTodos || null}>
              <TodoList todos={todos} onChange={onSetTodos} />
            </Card>
          )}
          {show.notes && <NotesCard />}
          {show.weather && <WeatherCard />}
          {show.calendar && <CalendarCard />}
          {show.word && <WordCard />}
          {show.links && <LinksCard checks={checks} />}
        </div>
      ) : (
        <div className="empty-state">
          Every Personal card is switched off — turn some back on in Settings.
        </div>
      )}
    </section>
  );
}

export default PersonalTab;
