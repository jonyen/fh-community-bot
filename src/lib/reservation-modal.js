// src/lib/reservation-modal.js
// The Edit modal on a reservation card. The receiver opens it straight from
// the button value (Slack allows 3 seconds), so building it needs nothing but
// the request and the catalog. Submitting updates the card; it never books.
import { findItem, CATEGORY_NAMES } from "./reservation-catalog.js";
import { hhmmToMin } from "./reservation-time.js";
import { APPLIANCES } from "../services/reservations/kitchen.js";

export const MODAL_CALLBACK = "reservation_edit_modal";
export const ITEM_ACTION = "reservation_items";

const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const plain = (text) => ({ type: "plain_text", text });
const option = (label) => ({ text: plain(label), value: label });

function input(blockId, label, element, { optional = false } = {}) {
  return { type: "input", block_id: blockId, label: plain(label), element: { action_id: blockId, ...element }, ...(optional ? { optional: true } : {}) };
}

export function applianceBlocks(appliances) {
  const bools = APPLIANCES.filter((a) => a.kind === "bool");
  const checked = bools.filter((a) => appliances[a.key] === true).map((a) => ({ text: plain(a.label), value: a.key }));
  return [
    input("appliances", "Kitchen equipment", {
      type: "checkboxes",
      options: bools.map((a) => ({ text: plain(a.label), value: a.key })),
      ...(checked.length ? { initial_options: checked } : {}),
    }, { optional: true }),
    ...APPLIANCES.filter((a) => a.kind === "count").map((a) => input(`count_${a.key}`, a.label, {
      type: "number_input", is_decimal_allowed: false, min_value: "0",
      ...(appliances[a.key] ? { initial_value: String(appliances[a.key]) } : {}),
    }, { optional: true })),
  ];
}

export function buildEditModal({ user, channel, threadTs, cardTs, req }) {
  const items = req.items.map((i) => option(i.label));
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK,
    private_metadata: JSON.stringify({ u: user, c: channel, th: threadTs, ct: cardTs, m: req.ministry || null }),
    title: plain("Reservation"),
    submit: plain("Update"),
    close: plain("Cancel"),
    blocks: [
      { type: "input", block_id: "items", label: plain("What to book"), element: {
        type: "multi_external_select", action_id: ITEM_ACTION, min_query_length: 1, placeholder: plain("Type to search"),
        ...(items.length ? { initial_options: items } : {}),
      } },
      input("date", "Day", { type: "datepicker", ...(req.date ? { initial_date: req.date } : {}) }),
      input("start", "Start", { type: "timepicker", ...(req.start != null ? { initial_time: hhmm(req.start) } : {}) }),
      input("end", "End", { type: "timepicker", ...(req.end != null ? { initial_time: hhmm(req.end) } : {}) }),
      input("title", "What it's for", { type: "plain_text_input", max_length: 150, ...(req.title ? { initial_value: req.title } : {}) }),
      ...(req.items.some((i) => i.category === "kitchen") ? applianceBlocks(req.appliances || {}) : []),
    ],
  };
}

const values = (view) => view?.state?.values || {};

// The timepicker has no 24:00, so an end of 00:00 after a later start is
// midnight at the end of the day (1440, as the adapters read it).
export function toTimes(startHHMM, endHHMM) {
  const start = hhmmToMin(startHHMM);
  let end = hhmmToMin(endHHMM);
  if (end === 0 && start > 0) end = 1440;
  return { start, end };
}

const readTimes = (v) => toTimes(v.start?.start?.selected_time, v.end?.end?.selected_time);

// Kitchen equipment from a view's or message's state values.
export function readAppliances(v) {
  const appliances = {};
  for (const o of v.appliances?.appliances?.selected_options || []) appliances[o.value] = true;
  for (const a of APPLIANCES.filter((x) => x.kind === "count")) {
    const n = Number(v[`count_${a.key}`]?.[`count_${a.key}`]?.value);
    if (Number.isInteger(n) && n > 0) appliances[a.key] = n;
  }
  return appliances;
}

export function readEditModal(view, catalog) {
  const v = values(view);
  let meta = {};
  try {
    meta = JSON.parse(view.private_metadata || "{}");
  } catch {
    meta = {};
  }
  const appliances = readAppliances(v);
  const items = (v.items?.[ITEM_ACTION]?.selected_options || []).map((o) => findItem(catalog, o.value)).filter(Boolean);
  return {
    user: meta.u, channel: meta.c, threadTs: meta.th, cardTs: meta.ct,
    req: {
      intent: "book", items, ambiguous: [], unmatched: [],
      date: v.date?.date?.selected_date || null, toDate: null,
      ...readTimes(v),
      title: (v.title?.title?.value || "").trim() || null,
      ministry: meta.m || null,
      appliances,
    },
  };
}

// Checks Slack's own required-field checks don't cover. Keys are block ids.
export function modalErrors(view) {
  const v = values(view);
  const errors = {};
  if (!(v.items?.[ITEM_ACTION]?.selected_options || []).length) errors.items = "Pick what to book.";
  const { start, end } = readTimes(v);
  if (start != null && end != null && end <= start) errors.end = "End must be after start.";
  return Object.keys(errors).length ? errors : null;
}

// Typeahead for the item select. Slack shows at most 100 options.
export function itemOptions(catalog, query) {
  const q = String(query || "").trim().toLowerCase();
  return catalog
    .filter((e) => e.label.toLowerCase().includes(q) || (CATEGORY_NAMES[e.category] || "").toLowerCase().includes(q))
    .slice(0, 100)
    .map((e) => option(e.label));
}
