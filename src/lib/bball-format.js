// src/lib/bball-format.js
// The basketball roll-call message: its text, and how the bot recognises one
// of its own. Folded in from ffx-bball-bot (src/shared/formatMessage.js).

const DEFAULT_HEADER_TEXT = "🏀 today?";
const DIVIDER = "──────────────";

// Posts go out under a chat:write.customize persona, which Slack stores as a
// `bot_message` with a bot_id and no `user`. So ownership can't be checked by
// user id; the metadata event type is the marker instead.
export const ROLLCALL_EVENT_TYPE = "bball_rollcall";
export const ROLLCALL_METADATA = { event_type: ROLLCALL_EVENT_TYPE, event_payload: {} };
export const ROLLCALL_PERSONA = { username: "FFX BBall", icon_emoji: ":basketball:" };

export function isRollCallMessage(message) {
  return message?.metadata?.event_type === ROLLCALL_EVENT_TYPE;
}

// BBALL_CHANNEL_IDS is comma-separated. Empty means the feature is off.
export function parseBballChannelIds(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function weatherLine(weather) {
  if (weather == null) return null;
  if (typeof weather === "string") return weather;
  return `${weather.icon} Nottoway Park — ${weather.tempF}°F, ${weather.description}`;
}

function mentions(users) {
  return users.map((u) => `<@${u}>`).join(", ");
}

export function formatMessage(roster, weather, { headerText } = {}) {
  const header = headerText || DEFAULT_HEADER_TEXT;
  const sections = [header];

  const rosterLines = [];
  if (roster.in.length) rosterLines.push(`In (${roster.in.length}): ${mentions(roster.in)}`);
  if (roster.maybe.length) rosterLines.push(`Maybe (${roster.maybe.length}): ${mentions(roster.maybe)}`);
  if (roster.out.length) rosterLines.push(`Out: ${mentions(roster.out)}`);
  if (rosterLines.length) sections.push(rosterLines.join("\n"));

  const line = weatherLine(weather);
  if (line) sections.push(`${DIVIDER}\n${line}`);

  return sections.join("\n\n");
}

export function parseWeatherLine(text) {
  const idx = text.indexOf(DIVIDER);
  if (idx === -1) return null;
  const after = text.slice(idx + DIVIDER.length);
  const match = after.match(/^\n(.+)$/);
  if (!match) return null;
  return match[1];
}

export function parseHeader(text) {
  return text.split("\n", 1)[0];
}
