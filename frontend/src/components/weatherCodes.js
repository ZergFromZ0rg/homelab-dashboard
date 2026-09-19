// WMO weather interpretation codes (what Open-Meteo returns) -> a label and
// which WeatherIcon to draw.
const TABLE = [
  [[0], "Clear", "clear"],
  [[1], "Mostly clear", "clear"],
  [[2], "Partly cloudy", "partly"],
  [[3], "Overcast", "cloud"],
  [[45, 48], "Fog", "fog"],
  [[51, 53, 55], "Drizzle", "drizzle"],
  [[56, 57], "Freezing drizzle", "drizzle"],
  [[61, 63, 65], "Rain", "rain"],
  [[66, 67], "Freezing rain", "rain"],
  [[71, 73, 75, 77], "Snow", "snow"],
  [[80, 81, 82], "Rain showers", "rain"],
  [[85, 86], "Snow showers", "snow"],
  [[95], "Thunderstorm", "storm"],
  [[96, 99], "Thunderstorm with hail", "storm"],
];

export function describeWeather(code) {
  const hit = TABLE.find(([codes]) => codes.includes(code));
  return hit ? { label: hit[1], icon: hit[2] } : { label: "Unknown", icon: "cloud" };
}
