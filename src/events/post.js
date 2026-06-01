import { formatMessage, parseWeatherLine } from "../lib/formatMessage.js";

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const WEATHER_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export function createPostMessageRunner({ client, fetchWeather, channels, botUserId, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
  async function fetchWeatherWithRetry() {
    for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await fetchWeather();
        if (result) return result;
      } catch (err) {
        console.error(`weather fetch attempt ${attempt} failed`, err);
      }
      if (attempt < WEATHER_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return null;
  }

  async function loadCachedWeatherLine() {
    for (const channel of channels) {
      try {
        const history = await client.conversations.history({ channel, limit: 20 });
        const target = (history.messages ?? []).find((m) => m.user === botUserId);
        const line = parseWeatherLine(target?.text ?? "");
        if (line) return `${line} (cached)`;
      } catch (err) {
        console.error("cached-weather lookup failed", channel, err);
      }
    }
    return null;
  }

  return async function run() {
    let weather = await fetchWeatherWithRetry();
    if (!weather && botUserId) {
      weather = await loadCachedWeatherLine();
      if (weather) console.warn("weather fetch failed; using cached line from prior post");
    }

    const text = formatMessage(EMPTY_ROSTER, weather);
    const results = await Promise.allSettled(
      channels.map((channel) => client.chat.postMessage({ channel, text }))
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === channels.length && channels.length > 0) {
      throw failures[0].reason;
    }
    return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  };
}
