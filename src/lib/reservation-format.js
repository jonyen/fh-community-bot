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

// Marks the one living digest post per period, so it can be found and edited.
export const DIGEST_EVENT_TYPE = "reservation_digest";

export function holderText(r) {
  return r.holderUserId ? `<@${r.holderUserId}>` : r.holder || "someone";
}

export function reservationLine(r) {
  const title = r.title ? ` · ${r.title}` : "";
  return `• ${fmtRange(r.start, r.end)} · ${r.item}${title} (${holderText(r)})`;
}

const byStart = (a, b) => (a.start ?? -1) - (b.start ?? -1);

// One message per period. Over maxChars, every day is cut to the same N
// reservation lines (largest N that fits) with "…+K more" on trimmed days.
export function buildLivingDigest({ kind, from, to, reservations, maxChars = 3500 }) {
  const header = `*${kind === "weekend" ? "This weekend" : "This week"}: ${fmtDay(from)} – ${fmtDay(to)}*`;
  if (reservations.length === 0) return `${header}\n\nNothing booked yet.`;

  const days = [...new Set(reservations.map((r) => r.date))].sort().map((date) => ({
    date,
    groups: Object.entries(CATEGORY_NAMES)
      .map(([id, name]) => ({ name, rs: reservations.filter((r) => r.date === date && r.category === id).sort(byStart) }))
      .filter((g) => g.rs.length > 0),
  }));

  const render = (limit) => {
    const blocks = days.map(({ date, groups }) => {
      const lines = [`*${fmtDay(date)}*`];
      let left = limit;
      let total = 0;
      for (const { name, rs } of groups) {
        total += rs.length;
        const shown = rs.slice(0, Math.max(0, left));
        left -= shown.length;
        if (shown.length) lines.push(`_${name}_`, ...shown.map(reservationLine));
      }
      if (total > limit) lines.push(`…+${total - limit} more`);
      return lines.join("\n");
    });
    return [header, ...blocks].join("\n\n");
  };

  const most = Math.max(...days.map((d) => d.groups.reduce((n, g) => n + g.rs.length, 0)));
  for (let n = most; n > 0; n--) {
    const text = render(n);
    if (text.length <= maxChars) return text;
  }
  return render(0);
}
