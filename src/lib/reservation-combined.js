// src/lib/reservation-combined.js
// After Reserve all the bot posts one public message: what the member reserved
// (a weekly repeat is one line, each with its own Cancel) and what could not be
// booked. Cancelling a repeat asks privately: the whole series or one date.
import { fitSection } from "./reservation-card.js";
import { fmtDay, fmtRange, nyToday } from "./reservation-time.js";
import { repeatText } from "./reservation-tray.js";

export const POST_CANCEL_ACTION = "reservation_post_cancel";
export const SERIES_ALL_ACTION = "reservation_series_all";
export const SERIES_ONE_ACTION = "reservation_series_one";
export const COMBINED_EVENT_TYPE = "reservation_combined";

// Slack caps a button value at 2,000 characters, a select at 100 options.
const VALUE_MAX = 2000;
const OPTIONS_MAX = 100;
const SECTION_MAX = 3000;
const BLOCK_ID_MAX = 255;
// Skips beyond this many collapse to "…and N more", each cut to SKIP_TEXT_MAX,
// so the message stays under Slack's 50 blocks.
const SKIPS_MAX = 40;
const SKIP_TEXT_MAX = 200;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (t) => ({ type: "plain_text", text: t });
const section = (text, accessory) => ({ type: "section", text: { type: "mrkdwn", text: fitSection(text) }, ...(accessory ? { accessory } : {}) });

// One mrkdwn section per run of lines, each under Slack's section cap.
function chunked(header, lines) {
  const out = [];
  let cur = header;
  for (const line of lines) {
    if (cur.length + 1 + line.length > SECTION_MAX && cur !== header) {
      out.push(section(cur));
      cur = line;
    } else {
      cur += `\n${line}`;
    }
  }
  out.push(section(cur));
  return out;
}

function cancelButton({ user, entry, index }) {
  const value = JSON.stringify(entry.ref
    ? { u: user, i: index, r: entry.ref }
    : { u: user, i: index, s: entry.seriesId });
  if (value.length > VALUE_MAX) return null;
  const button = { type: "button", action_id: POST_CANCEL_ACTION, style: "danger", text: plain("Cancel"), value };
  // A single date is cancelled here; a series asks which dates in the chooser.
  if (entry.ref) {
    button.confirm = {
      title: plain("Cancel this booking?"),
      text: plain(`${entry.summary} will be released.`.slice(0, 300)),
      confirm: plain("Cancel booking"),
      deny: plain("Keep it"),
    };
  }
  return button;
}

// booked: [{ summary, ref? | seriesId?, count }]; skipped: [{ text }].
// `index` in a button value is the entry's place in `booked`, so
// markLineCancelled can find its section again.
export function combinedMessage({ user, booked, skipped = [] }) {
  const blocks = [
    section(`✅ <@${user}> reserved:`),
    ...booked.map((entry, index) => section(`• ${esc(entry.summary)}`, cancelButton({ user, entry, index }))),
  ];
  if (skipped.length) {
    const lines = skipped.slice(0, SKIPS_MAX).map((s) => `• ${esc(String(s.text).slice(0, SKIP_TEXT_MAX))}`);
    if (skipped.length > SKIPS_MAX) lines.push(`…and ${skipped.length - SKIPS_MAX} more.`);
    blocks.push(...chunked("⚠️ Not booked, already claimed or unavailable:", lines));
  }
  return {
    // Slack reads the fallback text as mrkdwn too, so member text is escaped here as well.
    text: `✅ Reserved: ${booked.map((b) => esc(b.summary)).join("; ")}`.slice(0, SECTION_MAX),
    blocks,
    metadata: { event_type: COMBINED_EVENT_TYPE, event_payload: { user } },
  };
}

// The booked entry at `index` gets `text` on a new line and loses its Cancel;
// every other block is untouched. `text` is mrkdwn the caller has already made safe.
export function markLineCancelled(message, index, text) {
  const at = index + 1; // block 0 is the header
  const blocks = message.blocks.map((b, i) => {
    if (i !== at) return b;
    const { accessory, ...rest } = b;
    return { ...rest, text: { ...b.text, text: fitSection(`${b.text.text}\n${text}`) } };
  });
  return { text: message.text, blocks, metadata: message.metadata };
}

// Asked privately when a series line's Cancel is pressed. `today` (ISO, default
// today in New York) sets which dates are "remaining": those not yet past.
export function seriesChooser({ user, series, postTs, channel, today = nyToday() }) {
  const ctx = { u: user, s: series.id, pt: postTs, c: channel };
  const blockId = JSON.stringify(ctx);
  if (blockId.length > BLOCK_ID_MAX) throw new Error(`seriesChooser: block_id is ${blockId.length} chars, Slack allows ${BLOCK_ID_MAX}`);
  const dates = [...new Set(series.refs.map((r) => r.date).filter((d) => d >= today))].sort();
  const when = series.start != null && series.end != null ? ` · ${fmtRange(series.start, series.end)}` : "";
  const head = `Cancel *${esc(series.item)}* · ${repeatText(series.repeat)}${when}`;
  const confirm = (title, text, yes) => ({ title: plain(title), text: plain(text), confirm: plain(yes), deny: plain("Keep it") });
  const elements = [
    {
      type: "button", action_id: SERIES_ALL_ACTION, style: "danger", text: plain("Whole series"), value: JSON.stringify(ctx),
      confirm: confirm("Cancel the whole series?", "Cancel every remaining date?", "Cancel series"),
    },
  ];
  if (dates.length) {
    elements.push({
      type: "static_select", action_id: SERIES_ONE_ACTION, placeholder: plain("Just one date"),
      options: dates.slice(0, OPTIONS_MAX).map((d) => ({ text: plain(fmtDay(d)), value: JSON.stringify({ d }) })),
      confirm: confirm("Cancel this date?", "Only the date you picked will be released.", "Cancel date"),
    });
  }
  return {
    text: head,
    blocks: [section(head), { type: "actions", block_id: blockId, elements }],
  };
}
