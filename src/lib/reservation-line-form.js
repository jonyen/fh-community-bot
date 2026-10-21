// src/lib/reservation-line-form.js
// The per-line edit form shown in the private card: when, what for, an
// optional weekly repeat and (for the kitchen) equipment. Pure message
// building and reading, no I/O; Save re-reads it with readLineForm.
import { CATEGORY_NAMES } from "./reservation-catalog.js";
import { applianceBlocks, readAppliances, toTimes, hhmm } from "./reservation-modal.js";
import { fitSection } from "./reservation-card.js";
import { whenOf, restartDates } from "./reservation-tray.js";

export const FORM_DATE_ACTION = "reservation_form_date";
export const FORM_START_ACTION = "reservation_form_start";
export const FORM_END_ACTION = "reservation_form_end";
export const FORM_REPEAT_ACTION = "reservation_form_repeat";
export const FORM_DAYS_ACTION = "reservation_form_days";
export const FORM_UNTIL_ACTION = "reservation_form_until";
export const FORM_SAVE_ACTION = "reservation_form_save";
export const FORM_REMOVE_ACTION = "reservation_form_remove";
export const FORM_BACK_ACTION = "reservation_form_back";
export const FORM_ACTIONS = new Set([
  FORM_DATE_ACTION, FORM_START_ACTION, FORM_END_ACTION, FORM_REPEAT_ACTION, FORM_DAYS_ACTION,
  FORM_UNTIL_ACTION, FORM_SAVE_ACTION, FORM_REMOVE_ACTION, FORM_BACK_ACTION,
]);

const TITLE_MAX = 150;
// Monday first, as repeatText reads them; the value is the 0 = Sunday number.
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];

const plain = (text) => ({ type: "plain_text", text });
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: fitSection(text) } });
const button = (action_id, text, extra = {}) => ({ type: "button", action_id, text: plain(text), value: action_id, ...extra });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// inTray: the line is already in the tray, so it can be removed from it.
export function lineFormMessage({ line, entry, check, problems, notice = null, inTray = false }) {
  const label = entry?.label || line.item;
  const blocks = [];
  if (notice) blocks.push(section(notice));
  blocks.push(section(`📅 *${esc(label)}* · ${CATEGORY_NAMES[entry?.category] || ""}`));
  blocks.push({
    type: "actions", block_id: "form_when",
    elements: [
      { type: "datepicker", action_id: FORM_DATE_ACTION, placeholder: plain("Day"), ...(line.date ? { initial_date: line.date } : {}) },
      { type: "timepicker", action_id: FORM_START_ACTION, placeholder: plain("Start"), ...(line.start != null ? { initial_time: hhmm(line.start) } : {}) },
      { type: "timepicker", action_id: FORM_END_ACTION, placeholder: plain("End"), ...(line.end != null ? { initial_time: hhmm(line.end) } : {}) },
    ],
  });
  blocks.push({
    type: "input", block_id: "title", optional: true, label: plain("What it's for"),
    element: { type: "plain_text_input", action_id: "title", max_length: TITLE_MAX, ...(line.title ? { initial_value: line.title } : {}) },
  });

  const repeatOptions = [{ text: plain("Just once"), value: "none" }, { text: plain("Repeats weekly"), value: "weekly" }];
  blocks.push({
    type: "actions", block_id: "form_repeat",
    elements: [{ type: "radio_buttons", action_id: FORM_REPEAT_ACTION, options: repeatOptions, initial_option: repeatOptions[line.repeat ? 1 : 0] }],
  });
  if (line.repeat) {
    const days = Array.isArray(line.repeat.days) ? line.repeat.days : [];
    const options = DAYS.map(([value, name]) => ({ text: plain(name), value: String(value) }));
    const initial = options.filter((o) => days.includes(Number(o.value)));
    blocks.push({
      type: "actions", block_id: "form_days",
      elements: [{ type: "checkboxes", action_id: FORM_DAYS_ACTION, options, ...(initial.length ? { initial_options: initial } : {}) }],
    });
    blocks.push({
      type: "actions", block_id: "form_until",
      elements: [{ type: "datepicker", action_id: FORM_UNTIL_ACTION, placeholder: plain("Repeat until"), ...(line.repeat.until ? { initial_date: line.repeat.until } : {}) }],
    });
  }
  if (entry?.category === "kitchen") blocks.push(...applianceBlocks(line.appliances || {}));

  // check and problems are built by the caller and must already be escaped.
  const status = [check, ...(problems || [])].filter(Boolean).join("\n");
  if (status) blocks.push(section(status));
  blocks.push({
    type: "actions", block_id: "form_buttons",
    elements: [
      button(FORM_SAVE_ACTION, "Save", { style: "primary" }),
      ...(inTray ? [button(FORM_REMOVE_ACTION, "Remove", { value: line.id })] : []),
      button(FORM_BACK_ACTION, "◀ Back to list"),
    ],
  });
  return { text: `Reserving ${esc(label)}`, blocks };
}

// The draft updated from payload.state.values; whatever the state does not
// carry keeps the draft's value.
export function readLineForm(v, line) {
  const out = { ...line };
  const when = v.form_when || {};
  const date = when[FORM_DATE_ACTION]?.selected_date;
  if (date) out.date = date;
  const startHH = when[FORM_START_ACTION]?.selected_time ?? (line.start != null ? hhmm(line.start) : null);
  const endHH = when[FORM_END_ACTION]?.selected_time ?? (line.end != null ? hhmm(line.end) : null);
  ({ start: out.start, end: out.end } = toTimes(startHH, endHH));
  if (v.title?.title) out.title = (v.title.title.value || "").trim() || null;

  const kind = v.form_repeat?.[FORM_REPEAT_ACTION]?.selected_option?.value;
  if (kind === "none") out.repeat = null;
  else if (kind === "weekly" || line.repeat) {
    const picked = v.form_days?.[FORM_DAYS_ACTION]?.selected_options;
    out.repeat = {
      days: picked ? picked.map((o) => Number(o.value)) : line.repeat?.days || [],
      until: v.form_until?.[FORM_UNTIL_ACTION]?.selected_date ?? line.repeat?.until ?? null,
    };
  }
  const hasAppliances = v.appliances || Object.keys(v).some((k) => k.startsWith("count_"));
  if (hasAppliances) out.appliances = readAppliances(v);
  // New dates: what was left of the old ones no longer applies.
  if (whenOf(out) !== whenOf(line)) restartDates(out);
  return out;
}
