import { DEMO, demoPersonal } from "../demoData";

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).detail;
    } catch {
      // not JSON — fall through to the status text
    }
    throw new Error(
      typeof detail === "string" && detail ? detail : `Request failed: ${response.status}`
    );
  }
  return response.json();
}

export function fetchWeather({ lat, lon, units }) {
  if (DEMO) return Promise.resolve(demoPersonal.weather(units));
  return getJson(`/api/personal/weather?lat=${lat}&lon=${lon}&units=${units}`);
}

export async function searchPlaces(query) {
  if (DEMO) return demoPersonal.places(query);
  const body = await getJson(`/api/personal/places?q=${encodeURIComponent(query)}`);
  return body.places;
}

export function fetchWord() {
  if (DEMO) return Promise.resolve(demoPersonal.word);
  return getJson("/api/personal/word");
}
