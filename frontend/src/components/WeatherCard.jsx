import { memo, useEffect, useState } from "react";
import Card from "./Card";
import WeatherIcon from "./WeatherIcon";
import { describeWeather } from "./weatherCodes";
import { fetchWeather, searchPlaces } from "./personalApi";
import { usePolled } from "./usePolled";
import { useSettings } from "./settings";

const REFRESH_MS = 15 * 60_000;

function weekday(dateString, index) {
  if (index === 0) return "Today";
  return new Date(`${dateString}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

function placeLabel(place) {
  return [place.name, place.region, place.country].filter(Boolean).join(", ");
}

// Inline city search — the location is a per-browser preference, so it's
// picked right on the card rather than in Settings. It only grabs focus
// when you asked to change the city: on first load an autofocused field
// scrolled the page down to it (and opened the keyboard on a phone).
function PlacePicker({ onPick, onCancel }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return undefined;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const places = await searchPlaces(text);
        if (cancelled) return;
        setResults(places);
        setStatus(places.length ? "" : "No matches.");
      } catch (error) {
        if (!cancelled) {
          setResults([]);
          setStatus(`Search failed: ${error.message}`);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const shown = query.trim().length >= 2 ? results : [];

  return (
    <div className="place-picker">
      <div className="place-picker-row">
        <input
          className="deploy-input"
          placeholder="Search for your city…"
          value={query}
          autoFocus={Boolean(onCancel)}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search for a city"
        />
        {onCancel && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {status && query.trim().length >= 2 && <p className="overview-empty">{status}</p>}
      {!onCancel && query.trim().length < 2 && (
        <p className="overview-empty">Pick a city for the current conditions and a five-day forecast.</p>
      )}
      {shown.length > 0 && (
        <ul className="place-results">
          {shown.map((p) => (
            <li key={`${p.latitude},${p.longitude}`}>
              <button type="button" onClick={() => onPick(p)}>
                {placeLabel(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Forecast({ weather }) {
  return (
    <ul className="forecast">
      {weather.daily.map((d, i) => (
        <li key={d.date} title={describeWeather(d.code).label}>
          <span className="forecast-day">{weekday(d.date, i)}</span>
          <WeatherIcon kind={describeWeather(d.code).icon} size={22} />
          <span className="forecast-temps">
            <strong>{d.high}°</strong>
            <span>{d.low}°</span>
          </span>
          {d.precip > 0 && <span className="forecast-precip">{d.precip}%</span>}
        </li>
      ))}
    </ul>
  );
}

// Today only: icon, the temperature now, the day's high and low, and the
// chance of rain or snow. The five-day strip and the details are the full card.
function Today({ data }) {
  const now = data.current;
  const today = data.daily[0];
  const sky = today ? describeWeather(today.code).label : null;
  return (
    <div className="weather-today">
      <WeatherIcon kind={describeWeather(now.code).icon} night={!now.is_day} size={34} />
      <div className="weather-today-main">
        <div className="weather-temp">
          {now.temperature}
          <span>{data.units.temp}</span>
        </div>
        <div className="weather-label">{describeWeather(now.code).label}</div>
      </div>
      {today && (
        <dl className="weather-today-day" title={`Feels like ${now.feels_like}°`}>
          <div>
            <dt>High</dt>
            <dd>{today.high}°</dd>
          </div>
          <div>
            <dt>Low</dt>
            <dd>{today.low}°</dd>
          </div>
          <div title={sky}>
            <dt>{/snow|sleet/i.test(sky) ? "Snow" : "Rain"}</dt>
            <dd>{today.precip ?? 0}%</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function WeatherCard({ compact = false }) {
  const { settings, update } = useSettings();
  const location = settings.weatherLocation;
  const units = settings.temperatureUnits;
  const [changing, setChanging] = useState(false);

  const key = location ? `${location.lat},${location.lon},${units}` : "none";
  const { data, error, loading } = usePolled(
    () => (location ? fetchWeather({ lat: location.lat, lon: location.lon, units }) : Promise.resolve(null)),
    key,
    location ? REFRESH_MS : 0
  );

  const pick = (place) => {
    update({
      weatherLocation: {
        name: place.name,
        region: place.region,
        country: place.country,
        lat: place.latitude,
        lon: place.longitude,
      },
    });
    setChanging(false);
  };

  const actions = location && !changing && (
    <>
      <div className="segmented segmented--sm" role="group" aria-label="Temperature units">
        {[
          ["metric", "°C"],
          ["imperial", "°F"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={units === value ? "active" : ""}
            aria-pressed={units === value}
            onClick={() => update({ temperatureUnits: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setChanging(true)}>
        Change
      </button>
    </>
  );

  return (
    <Card title={location ? (compact ? location.name : `Weather · ${location.name}`) : "Weather"} actions={actions}>
      {(!location || changing) && (
        <PlacePicker onPick={pick} onCancel={location ? () => setChanging(false) : null} />
      )}

      {location && !changing && (
        <>
          {loading && <p className="overview-empty">Loading…</p>}
          {!loading && !data && (
            <p className="overview-empty">
              Couldn't load the weather{error ? ` (${error})` : ""}. The dashboard backend needs
              outbound internet access.
            </p>
          )}
          {data && compact && <Today data={data} />}
          {data && !compact && (
            <>
              <div className="weather-now">
                <WeatherIcon
                  kind={describeWeather(data.current.code).icon}
                  night={!data.current.is_day}
                  size={52}
                />
                <div>
                  <div className="weather-temp">
                    {data.current.temperature}
                    <span>{data.units.temp}</span>
                  </div>
                  <div className="weather-label">{describeWeather(data.current.code).label}</div>
                </div>
                <dl className="weather-facts">
                  <div>
                    <dt>Feels like</dt>
                    <dd>{data.current.feels_like}°</dd>
                  </div>
                  <div>
                    <dt>Humidity</dt>
                    <dd>{data.current.humidity}%</dd>
                  </div>
                  <div>
                    <dt>Wind</dt>
                    <dd>
                      {data.current.wind} {data.units.wind}
                    </dd>
                  </div>
                </dl>
              </div>
              <Forecast weather={data} />
              <p className="card-credit">
                Weather data by{" "}
                <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
                  Open-Meteo
                </a>
              </p>
            </>
          )}
        </>
      )}
    </Card>
  );
}

// Memoized: it takes no fleet data, so the 2 s dashboard tick needn't
// re-render it.
export default memo(WeatherCard);
