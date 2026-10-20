// src/lib/reservation-card.js
// A booking request is answered with a card: what the bot understood, whether
// it is free, and Book / Edit buttons. The request rides in the buttons' value,
// so the card is its own state and nothing is stored anywhere else.
import { findItem } from "./reservation-catalog.js";
import { fmtDay, fmtRange } from "./reservation-time.js";
import { reservationLine, CLOSED_METADATA } from "./reservation-format.js";

export const BOOK_ACTION = "reservation_book";
export const EDIT_ACTION = "reservation_edit";
export const CARD_EVENT_TYPE = "reservation_card";

// Slack caps a button value at 2,000 characters.
const TITLE_MAX = 150;
const MINISTRY_MAX = 100;
const cut = (s, n) => (s ? String(s).slice(0, n) : null);

export function encodeCard({ user, req }) {
  return JSON.stringify({
    u: user,
    i: req.items.map((i) => i.label),
    d: req.date,
    s: req.start,
    e: req.end,
    t: cut(req.title, TITLE_MAX),
    m: cut(req.ministry, MINISTRY_MAX),
    a: req.appliances || {},
  });
}

export function decodeCard(value, catalog) {
  let v;
  try {
    v = JSON.parse(value);
  } catch {
    return null;
  }
  if (!v || typeof v.u !== "string") return null;
  const items = (Array.isArray(v.i) ? v.i : []).map((l) => findItem(catalog, l)).filter(Boolean);
  const num = (n) => (Number.isInteger(n) ? n : null);
  return {
    user: v.u,
    req: {
      intent: "book", items, ambiguous: [], unmatched: [],
      date: typeof v.d === "string" ? v.d : null, toDate: null,
      start: num(v.s), end: num(v.e),
      title: v.t || null, ministry: v.m || null,
      appliances: v.a && typeof v.a === "object" ? v.a : {},
    },
  };
}

function summary(req, { bold }) {
  const names = req.items.map((i) => i.label).join(", ");
  const what = names ? (bold ? `*${names}*` : names) : bold ? "*_what?_*" : "what?";
  const day = req.date ? fmtDay(req.date) : "_day?_";
  const time = req.start != null && req.end != null ? fmtRange(req.start, req.end) : "_time?_";
  return `📅 ${what} · ${day} · ${time} · ${req.title || "_what for?_"}`;
}

function status({ state, conflicts = [], missing = [], ambiguous = [] }) {
  if (state === "free") return "✅ Free";
  if (state === "taken") return `❌ Taken:\n${conflicts.map(reservationLine).join("\n")}\nCheck with them, or press Edit to pick another time.`;
  if (state === "missing") return `Missing: ${missing.join(", ")}. Press Edit to fill it in.`;
  if (state === "ambiguous") {
    const a = ambiguous[0];
    return `Which one did you mean by "${a.phrase}": ${a.options.map((o) => o.label).join(", ")}? Press Edit to pick.`;
  }
  if (state === "past") return "That date has passed. Press Edit to change it.";
  return "Rooms, the kitchen and equipment are booked separately. Press Edit to pick one kind.";
}

export function cardMessage({ user, req, assessment }) {
  const value = encodeCard({ user, req });
  const buttons = [
    ...(assessment.state === "free"
      ? [{ type: "button", action_id: BOOK_ACTION, style: "primary", text: { type: "plain_text", text: "Book" }, value }]
      : []),
    { type: "button", action_id: EDIT_ACTION, text: { type: "plain_text", text: "Edit" }, value },
  ];
  return {
    text: summary(req, { bold: false }),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${summary(req, { bold: true })}\n${status(assessment)}` } },
      { type: "actions", elements: buttons },
    ],
    metadata: { event_type: CARD_EVENT_TYPE, event_payload: { user } },
  };
}

// The card once it is booked or refused: the outcome, no buttons.
export function closedMessage(text) {
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }], metadata: CLOSED_METADATA };
}

// The Book value on a card as it stands now; null once it is closed, edited
// into a state that can't be booked, or gone.
export function openBookValue(message) {
  for (const b of message?.blocks || []) {
    if (b.type !== "actions") continue;
    const book = b.elements.find((e) => e.action_id === BOOK_ACTION);
    if (book) return book.value;
  }
  return null;
}
