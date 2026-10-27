import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchWeather,
  fetchWeatherWithRetry,
  loadCachedWeatherLine,
  resolveWeather,
  pickIcon,
  noonEtMsFor,
} from "../../src/services/bballWeather.js";
import { ROLLCALL_METADATA } from "../../src/lib/bball-format.js";

describe("pickIcon", () => {
  it.each([
    ["Sunny", "☀️"],
    ["Clear", "☀️"],
    ["Partly Sunny", "⛅"],
    ["Mostly Sunny", "⛅"],
    ["Partly Cloudy", "⛅"],
    ["Mostly Cloudy", "☁️"],
    ["Cloudy", "☁️"],
    ["Overcast", "☁️"],
    ["Light Rain", "🌧️"],
    ["Rain Showers", "🌧️"],
    ["Slight Chance Showers And Thunderstorms", "⛈️"],
    ["Chance Drizzle", "🌧️"],
    ["Snow", "❄️"],
    ["Sleet", "❄️"],
    ["Thunderstorms", "⛈️"],
    ["Fog", "🌫️"],
    ["Haze", "🌫️"],
    ["", "🌡️"],
  ])("maps %s to %s", (shortForecast, icon) => {
    expect(pickIcon(shortForecast)).toBe(icon);
  });
});

describe("noonEtMsFor", () => {
  it("returns noon EDT (16:00 UTC) during daylight-saving time", () => {
    expect(new Date(noonEtMsFor(new Date("2026-04-10T13:00:00Z"))).toISOString()).toBe("2026-04-10T16:00:00.000Z");
  });

  it("returns noon EST (17:00 UTC) during standard time", () => {
    expect(new Date(noonEtMsFor(new Date("2026-01-15T13:00:00Z"))).toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  it("uses the ET calendar date, not the UTC one, near midnight", () => {
    expect(new Date(noonEtMsFor(new Date("2026-04-11T02:00:00Z"))).toISOString()).toBe("2026-04-10T16:00:00.000Z");
  });
});

describe("fetchWeather", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const POINTS_URL = "https://api.weather.gov/points/38.887947,-77.275015";
  const HOURLY_URL = "https://api.weather.gov/gridpoints/LWX/96,70/forecast/hourly";

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mockNws(periods) {
    globalThis.fetch.mockImplementation(async (url) => {
      if (url === POINTS_URL) return { ok: true, json: async () => ({ properties: { forecastHourly: HOURLY_URL } }) };
      if (url === HOURLY_URL) return { ok: true, json: async () => ({ properties: { periods } }) };
      return { ok: false, status: 404 };
    });
  }

  const period = (startTime, temperature, shortForecast) => ({ startTime, temperature, temperatureUnit: "F", shortForecast });

  it("calls the NWS points endpoint for Nottoway Park, then follows forecastHourly", async () => {
    mockNws([period("2026-04-14T12:00:00-04:00", 79, "Sunny")]);
    await fetchWeather();
    const urls = globalThis.fetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([POINTS_URL, HOURLY_URL]);
  });

  it("sends the User-Agent header NWS requires and an AbortSignal", async () => {
    mockNws([period("2026-04-14T12:00:00-04:00", 79, "Sunny")]);
    await fetchWeather();
    for (const [, init] of globalThis.fetch.mock.calls) {
      expect(init.headers["User-Agent"]).toBeTruthy();
      expect(init.headers.Accept).toContain("geo+json");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("picks the hourly period closest to noon ET on the current ET day", async () => {
    mockNws([
      period("2026-04-14T08:00:00-04:00", 67, "Sunny"),
      period("2026-04-14T11:00:00-04:00", 74, "Sunny"),
      period("2026-04-14T12:00:00-04:00", 79, "Sunny"),
      period("2026-04-14T13:00:00-04:00", 82, "Partly Sunny"),
    ]);
    const result = await fetchWeather({ now: new Date("2026-04-14T13:00:00Z") });
    expect(result).toEqual({ icon: "☀️", tempF: 79, description: "Sunny" });
  });

  it("rounds temperature", async () => {
    mockNws([period("2026-04-14T12:00:00-04:00", 72.6, "Sunny")]);
    expect((await fetchWeather({ now: new Date("2026-04-14T13:00:00Z") })).tempF).toBe(73);
  });

  it("returns null when the points endpoint responds non-ok", async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500 });
    expect(await fetchWeather()).toBeNull();
  });

  it("returns null when the hourly endpoint responds non-ok", async () => {
    globalThis.fetch.mockImplementation(async (url) =>
      url === POINTS_URL ? { ok: true, json: async () => ({ properties: { forecastHourly: HOURLY_URL } }) } : { ok: false, status: 500 }
    );
    expect(await fetchWeather()).toBeNull();
  });

  it("returns null when fetch throws or the periods list is empty", async () => {
    globalThis.fetch.mockRejectedValue(new Error("network down"));
    expect(await fetchWeather()).toBeNull();
    mockNws([]);
    expect(await fetchWeather()).toBeNull();
  });

  it("aborts when the timeoutMs option elapses", async () => {
    vi.useFakeTimers();
    let capturedSignal;
    globalThis.fetch.mockImplementation((_url, init) => {
      capturedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const pending = fetchWeather({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeNull();
    expect(capturedSignal.aborted).toBe(true);
  });
});

describe("fetchWeatherWithRetry", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("retries on a null or thrown result, sleeping between attempts", async () => {
    const fetchWeatherImpl = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("nws 502"))
      .mockResolvedValueOnce({ icon: "☀️", tempF: 72, description: "Clear sky" });
    const sleep = vi.fn().mockResolvedValue();
    const result = await fetchWeatherWithRetry({ fetchWeatherImpl, sleep });
    expect(result.tempF).toBe(72);
    expect(fetchWeatherImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts", async () => {
    const fetchWeatherImpl = vi.fn().mockResolvedValue(null);
    expect(await fetchWeatherWithRetry({ fetchWeatherImpl, sleep: async () => {} })).toBeNull();
    expect(fetchWeatherImpl).toHaveBeenCalledTimes(3);
  });
});

describe("loadCachedWeatherLine / resolveWeather", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const rollCall = (text) => ({ subtype: "bot_message", bot_id: "B1", text, metadata: ROLLCALL_METADATA });

  it("uses the weather line from the latest roll-call, tagged (cached)", async () => {
    const client = {
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [rollCall("🏀 today?\n\n──────────────\n☀️ Nottoway Park — 70°F, Sunny")] }),
      },
    };
    expect(await loadCachedWeatherLine({ client, channels: ["C1"] })).toBe("☀️ Nottoway Park — 70°F, Sunny (cached)");
    expect(client.conversations.history).toHaveBeenCalledWith({ channel: "C1", limit: 20, include_all_metadata: true });
  });

  it("ignores messages without the roll-call metadata and tries the next channel", async () => {
    const lookalike = { subtype: "bot_message", bot_id: "B2", text: "🏀 today?\n\n──────────────\n☁️ Nottoway Park — 1°F, Fake" };
    const client = {
      conversations: {
        history: vi
          .fn()
          .mockResolvedValueOnce({ messages: [lookalike, { user: "UHUMAN", text: "hi" }] })
          .mockResolvedValueOnce({ messages: [rollCall("🏀 today?\n\n──────────────\n⛅ Nottoway Park — 65°F, Partly Sunny")] }),
      },
    };
    expect(await loadCachedWeatherLine({ client, channels: ["C1", "C2"] })).toBe("⛅ Nottoway Park — 65°F, Partly Sunny (cached)");
  });

  it("tolerates history throwing", async () => {
    const client = { conversations: { history: vi.fn().mockRejectedValue(new Error("slack 500")) } };
    expect(await loadCachedWeatherLine({ client, channels: ["C1"] })).toBeNull();
  });

  it("resolveWeather prefers the live forecast and skips history", async () => {
    const client = { conversations: { history: vi.fn() } };
    const live = { icon: "☀️", tempF: 72, description: "Clear sky" };
    const result = await resolveWeather({ client, channels: ["C1"], fetchWeatherImpl: async () => live, sleep: async () => {} });
    expect(result).toBe(live);
    expect(client.conversations.history).not.toHaveBeenCalled();
  });
});
