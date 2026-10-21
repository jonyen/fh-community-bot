// src/lib/reservation-mine.js
// "What do I have booked?": the asker's upcoming bookings, privately, one
// line each with a Cancel button. A line found by a guessed name says so, and
// its confirm quotes the sheet row as typed so a wrong match is easy to spot.
import { fmtDay, fmtRange } from "./reservation-time.js";
import { encodeRef, fitSection } from "./reservation-card.js";
import { repeatText } from "./reservation-tray.js";

export const MINE_CANCEL_ACTION = "reservation_mine_cancel";
export const MINE_OPEN_ACTION = "reservation_mine_open";
export const MINE_SERIES_ACTION = "reservation_mine_series";
export const NONE_TEXT = "I don't see any upcoming bookings under your name.";
const HEAD_TEXT = "Your upcoming bookings";
const PARTIAL_TEXT = "⚠️ Some bookings couldn't be checked.";
// Slack caps a button value at 2,000 characters and confirm text at 300.
const VALUE_MAX = 2000;
const CONFIRM_MAX = 300;

// Slack reads mrkdwn: member text is escaped so it can't ping or link.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (text) => ({ type: "plain_text", text });
const section = (text, accessory) => ({ type: "section", text: { type: "mrkdwn", text: fitSection(text) }, ...(accessory ? { accessory } : {}) });

// Labels in a fixed order; only backends that are configured have a link.
export function linksLine(links = {}) {
  return [["Rooms", links.rooms], ["Kitchen", links.kitchen], ["Calendar", links.calendar]]
    .filter(([, url]) => url)
    .map(([label, url]) => `${label}: ${url}`)
    .join(" · ");
}

// A booked repeat series is one line; its Cancel… asks which dates.
function seriesLine(e) {
  const title = String(e.title ?? "").trim();
  return `📅 *${esc(e.item)}* · ${repeatText(e.repeat)} · ${e.count} date${e.count === 1 ? "" : "s"} left · ${fmtRange(e.start, e.end)}${title ? ` · ${esc(title)}` : ""}`;
}

function entryLine(e) {
  if (e.series) return seriesLine(e);
  const title = String(e.title ?? "").trim();
  const source = e.matchedBy ? ` · from the ${e.matchedBy} sheet, matched by name` : "";
  return `📅 *${esc(e.item)}* · ${fmtDay(e.date)} · ${fmtRange(e.start, e.end)}${title ? ` · ${esc(title)}` : ""}${source}`;
}

function confirmText(e) {
  const when = `${fmtDay(e.date)} · ${fmtRange(e.start, e.end)}`;
  if (!e.matchedBy) return `${e.item} · ${when} will be released.`;
  // A kitchen row's title is its name, so quote the name once.
  const row = e.matchedBy === "kitchen" ? `${e.holderName ?? ""}` : `"${e.title ?? ""}" · ${e.holderName ?? ""}`;
  return `${row} · ${when} in the ${e.matchedBy} sheet`;
}

function accessoryFor(user, e) {
  if (e.series) {
    const value = JSON.stringify({ u: user, s: e.seriesId });
    return value.length > VALUE_MAX ? null : { type: "button", action_id: MINE_SERIES_ACTION, text: plain("Cancel…"), value };
  }
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
