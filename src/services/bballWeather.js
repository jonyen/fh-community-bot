// src/services/bballWeather.js
// The weather line on the basketball roll-call: the National Weather Service
// hourly forecast for Nottoway Park at noon ET, retried, with the line from
// the last roll-call as a fallback. Folded in from ffx-bball-bot
// (src/postMessage/weather.js and src/shared/weatherResolver.js).
import { isRollCallMessage, parseWeatherLine } from "../lib/bball-format.js";
import { log } from "../lib/logger.js";

// Nottoway Park, Vienna, VA (9537 Courthouse Rd)
const NOTTOWAY_LAT = 38.887947;
const NOTTOWAY_LON = -77.275015;
const DEFAULT_TIMEOUT_MS = 8000;
const POINTS_URL = `https://api.weather.gov/points/${NOTTOWAY_LAT},${NOTTOWAY_LON}`;
// NWS rejects requests without a User-Agent and asks for contact details in it.
const USER_AGENT = "fh-community-bot (https://github.com/jonyen/fh-community-bot)";

const WEATHER_MAX_ATTEMPTS = 3;
const WEATHER_RETRY_DELAY_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Order matters: more specific rules first so "Mostly Sunny" doesn't fall
// through to the bare "sunny" rule, and thunder beats plain rain.
const ICON_RULES = [
  [/thunder|t-storm/i, "⛈️"],
  [/snow|sleet|ice|blizzard|flurries/i, "❄️"],
  [/rain|shower|drizzle/i, "🌧️"],
  [/fog|mist|haze|smoke/i, "🌫️"],
  [/partly|mostly sunny|mostly clear/i, "⛅"],
  [/sunny|clear/i, "☀️"],
  [/cloud|overcast/i, "☁️"],
];

export function pickIcon(shortForecast = "") {
  for (const [re, icon] of ICON_RULES) {
    if (re.test(shortForecast)) return icon;
  }
  return "🌡️";
}

// Unix milliseconds for 12:00 local time in America/New_York on the ET calendar
// date of `now`. DST-safe via Intl.DateTimeFormat.
export function noonEtMsFor(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);

  const probe = Date.UTC(year, month - 1, day, 12, 0, 0);
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date(probe))
  );
  return probe + (12 - etHour) * 3600 * 1000;
}

function pickClosest(periods, targetMs) {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const p of periods) {
    const t = new Date(p.startTime).getTime();
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - targetMs);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }
  return best;
}

async function nwsFetch(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/geo+json",
    },
  });
  if (!response.ok) return null;
  return response.json();
}

// Resolves to { icon, tempF, description }, or null on any failure.
export async function fetchWeather({ timeoutMs = DEFAULT_TIMEOUT_MS, now = new Date(), target = "noon" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const targetMs = target === "now" ? now.getTime() : noonEtMsFor(now);

  try {
    // The points lookup returns the gridpoint's forecastHourly URL, so the
    // grid office/x/y never need hard-coding.
    const points = await nwsFetch(POINTS_URL, controller.signal);
    const forecastHourlyUrl = points?.properties?.forecastHourly;
    if (!forecastHourlyUrl) return null;

    const forecast = await nwsFetch(forecastHourlyUrl, controller.signal);
    const entry = pickClosest(forecast?.properties?.periods, targetMs);
    if (!entry) return null;

    const shortForecast = entry.shortForecast ?? "";
    return {
      icon: pickIcon(shortForecast),
      tempF: Math.round(entry.temperature ?? 0),
      description: shortForecast,
    };
  } catch (error) {
    log.warn("bball: weather fetch failed", { error });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWeatherWithRetry({ fetchWeatherImpl = fetchWeather, sleep = defaultSleep, now } = {}) {
  for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchWeatherImpl({ target: "noon", ...(now ? { now } : {}) });
      if (result) return result;
    } catch (error) {
      log.warn("bball: weather fetch attempt failed", { attempt, error });
    }
    if (attempt < WEATHER_MAX_ATTEMPTS) await sleep(WEATHER_RETRY_DELAY_MS);
  }
  return null;
}

// When the live NWS fetch is unrecoverable, fall back to the weather line from
// the most recent roll-call in any channel. The line is kept verbatim and
// tagged "(cached)" so readers know it's stale.
export async function loadCachedWeatherLine({ client, channels }) {
  for (const channel of channels) {
    try {
      const history = await client.conversations.history({ channel, limit: 20, include_all_metadata: true });
      const target = (history?.messages ?? []).find(isRollCallMessage);
      const line = parseWeatherLine(target?.text ?? "");
      if (line) return `${line} (cached)`;
    } catch (error) {
      log.warn("bball: cached-weather lookup failed", { channel, error });
    }
  }
  return null;
}

// Live NWS (with retry) first, then the cached line from a prior post. Returns
// a weather object, a "(cached)" string, or null when nothing is available.
export async function resolveWeather({ client, channels = [], fetchWeatherImpl, sleep, now } = {}) {
  let weather = await fetchWeatherWithRetry({ fetchWeatherImpl, sleep, now });
  if (!weather) {
    weather = await loadCachedWeatherLine({ client, channels });
    if (weather) log.warn("bball: weather fetch failed; using cached line from prior post");
  }
  return weather;
}
