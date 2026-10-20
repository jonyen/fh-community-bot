// src/lib/reservation-mine.js
// "What do I have booked?": the asker's upcoming bookings, privately, one
// line each with a Cancel button. A line found by a guessed name says so, and
// its confirm quotes the sheet row as typed so a wrong match is easy to spot.
import { fmtDay, fmtRange } from "./reservation-time.js";
import { encodeRef } from "./reservation-card.js";

export const MINE_CANCEL_ACTION = "reservation_mine_cancel";
export const MINE_OPEN_ACTION = "reservation_mine_open";
export const NONE_TEXT = "I don't see any upcoming bookings under your name.";
const HEAD_TEXT = "Your upcoming bookings";
const PARTIAL_TEXT = "⚠️ Some bookings couldn't be checked.";
// Slack caps a button value at 2,000 characters and confirm text at 300.
const VALUE_MAX = 2000;
const CONFIRM_MAX = 300;

const plain = (text) => ({ type: "plain_text", text });
const section = (text, accessory) => ({ type: "section", text: { type: "mrkdwn", text }, ...(accessory ? { accessory } : {}) });

// Labels in a fixed order; only backends that are configured have a link.
export function linksLine(links = {}) {
  return [["Rooms", links.rooms], ["Kitchen", links.kitchen], ["Calendar", links.calendar]]
    .filter(([, url]) => url)
    .map(([label, url]) => `${label}: ${url}`)
    .join(" · ");
}

function entryLine(e) {
  const title = String(e.title ?? "").trim();
  const source = e.matchedBy ? ` · from the ${e.matchedBy} sheet, matched by name` : "";
  return `📅 *${e.item}* · ${fmtDay(e.date)} · ${fmtRange(e.start, e.end)}${title ? ` · ${title}` : ""}${source}`;
}

function confirmText(e) {
  const when = `${fmtDay(e.date)} · ${fmtRange(e.start, e.end)}`;
  return e.matchedBy
    ? `"${e.title ?? ""}" · ${e.holderName ?? ""} · ${when} in the ${e.matchedBy} sheet`
    : `${e.item} · ${when} will be released.`;
}

function accessoryFor(user, e) {
  if (e.openLink) return { type: "button", action_id: MINE_OPEN_ACTION, text: plain("Open in Calendar"), url: e.openLink };
  const value = encodeRef({ user, ref: e.ref });
  if (value.length > VALUE_MAX) return null;
  return {
    type: "button", action_id: MINE_CANCEL_ACTION, text: plain("Cancel"), value,
    confirm: { title: plain("Cancel this booking?"), text: plain(confirmText(e).slice(0, CONFIRM_MAX)), confirm: plain("Cancel booking"), deny: plain("Keep it") },
  };
}

// entries: at most 20 (the caller caps), so the message stays well under
// Slack's 50 blocks.
export function mineMessage({ user, entries, more = 0, links, partial = false, notice = null }) {
  const blocks = [];
  if (notice) blocks.push(section(notice));
  const linkText = linksLine(links);
  if (entries.length === 0) {
    blocks.push(section(linkText ? `${NONE_TEXT}\n${linkText}` : NONE_TEXT));
  } else {
    blocks.push(section(`📋 ${HEAD_TEXT}:`));
    for (const e of entries) blocks.push(section(entryLine(e), accessoryFor(user, e)));
  }
  if (partial) blocks.push(section(PARTIAL_TEXT));
  if (entries.length && more > 0) blocks.push(section(`…and ${more} more.${linkText ? ` ${linkText}` : ""}`));
  const main = entries.length ? HEAD_TEXT : NONE_TEXT;
  return { text: notice ? `${notice}\n${main}` : main, blocks };
}
