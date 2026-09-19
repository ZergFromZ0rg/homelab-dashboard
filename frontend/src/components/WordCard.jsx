import Card from "./Card";
import { fetchWord } from "./personalApi";
import { usePolled } from "./usePolled";

const HOUR = 3600_000;

function WordCard() {
  const { data, error, loading } = usePolled(fetchWord, "word", HOUR);

  return (
    <Card title="Word of the day">
      {loading && <p className="overview-empty">Loading…</p>}
      {!loading && !data && (
        <p className="overview-empty">Couldn't load today's word{error ? ` (${error})` : ""}.</p>
      )}
      {data && (
        <div className="word">
          <div className="word-head">
            <a
              className="word-term"
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open on Wiktionary"
            >
              {data.word}
            </a>
            {data.part_of_speech && <span className="chip">{data.part_of_speech}</span>}
          </div>
          <ol className="word-defs">
            {data.definitions.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ol>
          <p className="card-credit">
            From <a href="https://en.wiktionary.org/" target="_blank" rel="noopener noreferrer">Wiktionary</a>
          </p>
        </div>
      )}
    </Card>
  );
}

export default WordCard;
