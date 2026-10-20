// src/lib/reservation-card.js
// A booking request is answered with a card: what the bot understood, whether
// it is free, and Book / Edit / Cancel buttons. The request rides in the buttons' value,
// so the card is its own state and nothing is stored anywhere else.
import { findItem } from "./reservation-catalog.js";
import { fmtDay, fmtRange } from "./reservation-time.js";
import { reservationLine, CLOSED_METADATA } from "./reservation-format.js";

export const BOOK_ACTION = "reservation_book";
export const EDIT_ACTION = "reservation_edit";
export const CANCEL_ACTION = "reservation_cancel";
export const CANCEL_BOOKING_ACTION = "reservation_cancel_booking";
export const CARD_EVENT_TYPE = "reservation_card";

// Slack caps a button value at 2,000 characters.
const VALUE_MAX = 2000;
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
  const labels = Array.isArray(v.i) ? v.i : [];
  const items = labels.map((l) => findItem(catalog, l)).filter(Boolean);
  // Labels the catalog no longer has (a resource renamed or removed since).
  const lost = labels.filter((l) => !findItem(catalog, l));
  const num = (n) => (Number.isInteger(n) ? n : null);
  return {
    user: v.u,
    lost,
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
    { type: "button", action_id: CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" }, value },
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

// Where a written booking lives, so Cancel booking can find it again. The
// value comes back from Slack, so it is checked before anything trusts it.
const REF_BACKENDS = new Set(["rooms", "kitchen", "rms"]);

export function encodeRef({ user, ref }) {
  return JSON.stringify({ u: user, r: ref });
}

export function decodeRef(value) {
  let v;
  try {
    v = JSON.parse(value);
  } catch {
    return null;
  }
  const r = v?.r;
  if (typeof v?.u !== "string" || !r || typeof r !== "object" || Array.isArray(r)) return null;
  if (!REF_BACKENDS.has(r.backend) || typeof r.date !== "string") return null;
  return { user: v.u, ref: r };
}

// The card once booked: the outcome and one Cancel booking button, behind
// Slack's confirm dialog. A ref too big for a button value gets no button.
export function bookedMessage({ user, text, ref, req }) {
  const value = encodeRef({ user, ref });
  if (value.length > VALUE_MAX) return closedMessage(text);
  const what = `${req.items.map((i) => i.label).join(", ")} · ${fmtDay(req.date)} · ${fmtRange(req.start, req.end)}`;
  const plain = (t) => ({ type: "plain_text", text: t });
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [{
        type: "button", action_id: CANCEL_BOOKING_ACTION, style: "danger", text: plain("Cancel booking"), value,
        confirm: { title: plain("Cancel this booking?"), text: plain(`${what} will be released.`.slice(0, 300)), confirm: plain("Cancel booking"), deny: plain("Keep it") },
      }] },
    ],
    metadata: CLOSED_METADATA,
  };
}

function button(message, actionId) {
  for (const b of message?.blocks || []) {
    if (b.type !== "actions") continue;
    const found = b.elements.find((e) => e.action_id === actionId);
    if (found) return found;
  }
  return null;
}

// The Book value on a card as it stands now; null once it is closed, edited
// into a state that can't be booked, or gone.
export function openBookValue(message) {
  return button(message, BOOK_ACTION)?.value ?? null;
}

// Every open card has Edit; a closed one has no buttons.
export function isOpenCard(message) {
  return !!button(message, EDIT_ACTION);
}

// The Cancel booking value on a booked card as it stands now; null once cancelled.
export function cancelBookingValue(message) {
  return button(message, CANCEL_BOOKING_ACTION)?.value ?? null;
}

// The first line of a card's text: on a booked card, the ✅ summary.
export function cardSummaryLine(message) {
  const section = (message?.blocks || []).find((b) => b.type === "section");
  return section?.text?.text?.split("\n")[0] ?? null;
}
