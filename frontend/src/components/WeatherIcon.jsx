const CLOUD = "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242";

// Line icons (24x24, currentColor) for the handful of conditions we show.
const PATHS = {
  clear: ["M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"],
  partly: ["M12 2v2", "m4.93 4.93 1.41 1.41", "M20 12h2", "m19.07 4.93-1.41 1.41", "M15.947 12.65a4 4 0 0 0-5.925-4.128", "M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"],
  cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
  fog: [CLOUD, "M16 17H7", "M17 21H9"],
  drizzle: [CLOUD, "M8 19v1", "M8 14v1", "M16 19v1", "M16 14v1", "M12 21v1", "M12 16v1"],
  rain: [CLOUD, "M16 14v6", "M8 14v6", "M12 16v6"],
  snow: [CLOUD, "M8 15h.01", "M8 19h.01", "M12 17h.01", "M12 21h.01", "M16 15h.01", "M16 19h.01"],
  storm: ["M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973", "m13 12-3 5h4l-3 5"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
};

function WeatherIcon({ kind, night = false, size = 24 }) {
  const paths = PATHS[night && kind === "clear" ? "moon" : kind] || PATHS.cloud;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`weather-icon weather-icon--${kind}`}
    >
      {kind === "clear" && !night && <circle cx="12" cy="12" r="4" />}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export default WeatherIcon;
