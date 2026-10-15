// src/lib/reservation-format.js
import { fmtRange, fmtDay } from "./reservation-time.js";
import { CATEGORY_NAMES } from "./reservation-catalog.js";

export const BOT_PERSONA = { username: "FH Reservations", icon_emoji: ":calendar:" };

// Marks a thread as finished so later replies ("thanks!") are never parsed
// into a second booking.
export const CLOSED_METADATA = { event_type: "reservation_closed", event_payload: {} };

// Marks the bot's post of a member's /reserve request, so the thread logic
// reads it as the member's words rather than the bot's.
export const REQUEST_EVENT_TYPE = "reservation_request";

export function holderText(r) {
  return r.holderUserId ? `<@${r.holderUserId}>` : r.holder || "someone";
}

export function reservationLine(r) {
  const title = r.title ? ` · ${r.title}` : "";
  return `• ${fmtRange(r.start, r.end)} · ${r.item}${title} (${holderText(r)})`;
}

const byStart = (a, b) => (a.start ?? -1) - (b.start ?? -1);

export function buildDigest({ from, to, reservations, maxChars = 3500 }) {
  const header = `*Reservations this week: ${fmtDay(from)} – ${fmtDay(to)}*`;
  if (reservations.length === 0) return [`${header}\n\nNo reservations this week.`];

  const days = [...new Set(reservations.map((r) => r.date))].sort();
  const blocks = days.map((date) => {
    const lines = [`*${fmtDay(date)}*`];
    for (const [id, name] of Object.entries(CATEGORY_NAMES)) {
      const rs = reservations.filter((r) => r.date === date && r.category === id).sort(byStart);
      if (rs.length === 0) continue;
      lines.push(`_${name}_`, ...rs.map(reservationLine));
    }
    return lines.join("\n");
  });

  const parts = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > maxChars && current !== header) {
      parts.push(current);
      current = block;
    } else {
      current = `${current}\n\n${block}`;
    }
  }
  parts.push(current);
  return parts;
}
