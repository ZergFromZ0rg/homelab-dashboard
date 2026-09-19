import Card from "./Card";
import Greeting from "./Greeting";
import LinksCard from "./LinksCard";
import TodoList from "./TodoList";
import WeatherCard from "./WeatherCard";
import WordCard from "./WordCard";
import { useSettings } from "./settings";

// The non-fleet stuff: to-dos, weather, a word, bookmarks. Each card can be
// switched off in Settings; the grid reflows around whatever's left.
function PersonalTab({ overview, todos, onSetTodos, openTodos }) {
  const {
    settings: { personalCards: show },
  } = useSettings();

  const anyCard = show.todo || show.weather || show.word || show.links;

  return (
    <section className="personal-tab">
      {show.greeting && <Greeting overview={overview} openTodos={openTodos} />}

      {anyCard ? (
        <div className="personal-grid">
          <div className="personal-col">
            {show.todo && (
              <Card title="To-do" count={openTodos || null}>
                <TodoList todos={todos} onChange={onSetTodos} />
              </Card>
            )}
            {show.links && <LinksCard />}
          </div>
          <div className="personal-col">
            {show.weather && <WeatherCard />}
            {show.word && <WordCard />}
          </div>
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
