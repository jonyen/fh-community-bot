// src/lib/dm-conversation.js
// Finds the open reservation request in a DM from its history, so a reply
// continues the request instead of starting a new one. Pure; no Slack calls.
import { REQUEST_EVENT_TYPE, CLOSED_METADATA } from "./reservation-format.js";

// A request idle longer than this is abandoned, even if chatter came after.
export const STALE_MS = 2 * 60 * 60 * 1000;

const ESCAPES = new Set(["start over", "cancel"]);

export function isEscape(text) {
  return ESCAPES.has(String(text ?? "").trim().toLowerCase());
}

// messages: newest first. Returns the open request oldest-first, from the
// start marker up to and including currentTs, or null.
export function openRequest(messages, { currentTs, nowMs }) {
  const current = Number(currentTs);
  // Walk newest first over messages at or before the current one.
  const history = messages.filter((m) => Number(m.ts) <= current);
  const prior = history.filter((m) => m.ts !== currentTs);

  for (let i = 0; i < prior.length; i++) {
    const eventType = prior[i].metadata?.event_type;
    if (eventType === CLOSED_METADATA.event_type && prior[i].bot_id) return null;
    if (eventType === REQUEST_EVENT_TYPE) {
      // prior[0] is the newest message before the current one.
      if (nowMs - Number(prior[0].ts) * 1000 > STALE_MS) return null;
      const upto = history.findIndex((m) => m === prior[i]);
      const request = history.slice(0, upto + 1).reverse();
      // Any long silence inside the request abandons it; later chatter
      // the bot ignored doesn't revive it.
      for (let j = 1; j < request.length; j++) {
        if ((Number(request[j].ts) - Number(request[j - 1].ts)) * 1000 > STALE_MS) return null;
      }
      return request;
    }
  }
  return null;
}
