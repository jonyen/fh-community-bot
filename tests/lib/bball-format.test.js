import { describe, it, expect } from "vitest";
import {
  formatMessage,
  parseWeatherLine,
  parseHeader,
  isRollCallMessage,
  parseBballChannelIds,
  ROLLCALL_METADATA,
} from "../../src/lib/bball-format.js";

const WEATHER = { icon: "☀️", tempF: 72, description: "Clear sky" };
const EMPTY = { in: [], out: [], maybe: [] };

describe("formatMessage", () => {
  it("initial message (no reactions) includes weather", () => {
    expect(formatMessage(EMPTY, WEATHER)).toBe("🏀 today?\n\n──────────────\n☀️ Nottoway Park — 72°F, Clear sky");
  });

  it("initial message with null weather omits the weather block", () => {
    expect(formatMessage(EMPTY, null)).toBe("🏀 today?");
  });

  it("renders users as slack mentions with a count on the In line", () => {
    expect(formatMessage({ in: ["U1", "U2"], out: [], maybe: [] }, WEATHER)).toContain("In (2): <@U1>, <@U2>");
  });

  it("only shows categories that have members", () => {
    const msg = formatMessage({ in: ["U1"], out: [], maybe: [] }, WEATHER);
    expect(msg).toContain("In (1): <@U1>");
    expect(msg).not.toContain("Out:");
    expect(msg).not.toContain("Maybe");
  });

  it("full message with reactions", () => {
    const msg = formatMessage({ in: ["U123", "U456"], out: ["U789"], maybe: ["U012"] }, WEATHER);
    expect(msg).toBe(
      "🏀 today?\n\n" +
        "In (2): <@U123>, <@U456>\n" +
        "Maybe (1): <@U012>\n" +
        "Out: <@U789>\n\n" +
        "──────────────\n" +
        "☀️ Nottoway Park — 72°F, Clear sky"
    );
  });

  it("with reactions but null weather still renders the roster", () => {
    expect(formatMessage({ in: ["U1"], out: [], maybe: [] }, null)).toBe("🏀 today?\n\nIn (1): <@U1>");
  });

  it("accepts a pre-formatted weather line string", () => {
    const msg = formatMessage({ in: ["U1"], out: [], maybe: [] }, "🌧️ Nottoway Park — 58°F, Light rain");
    expect(msg).toBe("🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n🌧️ Nottoway Park — 58°F, Light rain");
  });

  it("uses a supplied header verbatim, and falls back to the default when empty", () => {
    expect(formatMessage(EMPTY, null, { headerText: ":basketball: today?" })).toBe(":basketball: today?");
    expect(formatMessage(EMPTY, null, { headerText: "" })).toBe("🏀 today?");
  });
});

describe("parseWeatherLine", () => {
  it("extracts the weather line from a formatted message", () => {
    const msg = "🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n☀️ Nottoway Park — 72°F, Clear sky";
    expect(parseWeatherLine(msg)).toBe("☀️ Nottoway Park — 72°F, Clear sky");
  });

  it("extracts the weather line from an initial (no-reaction) message", () => {
    expect(parseWeatherLine("🏀 today?\n\n──────────────\n☀️ Nottoway Park — 72°F, Clear sky")).toBe("☀️ Nottoway Park — 72°F, Clear sky");
  });

  it("returns null when the message has no weather block", () => {
    expect(parseWeatherLine("🏀 today?\n\nIn (1): <@U1>")).toBeNull();
  });
});

describe("parseHeader", () => {
  it("returns the first line of a multi-line message", () => {
    expect(parseHeader("🏀 today?\n\n──────────────\n☀️ weather")).toBe("🏀 today?");
  });

  it("handles a single-line message", () => {
    expect(parseHeader("🏀 today?")).toBe("🏀 today?");
  });

  it("preserves the :basketball: shortcode form that Slack stores", () => {
    expect(parseHeader(":basketball: today?")).toBe(":basketball: today?");
  });
});

describe("isRollCallMessage", () => {
  it("recognises a message by its metadata event type", () => {
    expect(isRollCallMessage({ subtype: "bot_message", bot_id: "B1", metadata: ROLLCALL_METADATA })).toBe(true);
  });

  it("rejects a message without the metadata, whoever posted it", () => {
    expect(isRollCallMessage({ subtype: "bot_message", bot_id: "B1", text: "🏀 today?" })).toBe(false);
    expect(isRollCallMessage({ user: "U1", text: "🏀 today?", metadata: { event_type: "other" } })).toBe(false);
    expect(isRollCallMessage(undefined)).toBe(false);
  });
});

describe("parseBballChannelIds", () => {
  it("splits, trims and drops empties", () => {
    expect(parseBballChannelIds(" C1, C2 ,,")).toEqual(["C1", "C2"]);
    expect(parseBballChannelIds("")).toEqual([]);
    expect(parseBballChannelIds(undefined)).toEqual([]);
  });
});
