// src/lib/reservation-request.js
// The model's JSON is a suggestion. Everything is checked back against the
// catalog and simple formats, so a hallucinated item or a garbled time is
// asked about instead of booked.
import { findItem } from "./reservation-catalog.js";
import { hhmmToMin } from "./reservation-time.js";
import { APPLIANCES } from "../services/reservations/kitchen.js";

const INTENTS = new Set(["book", "check", "list", "find", "mine", "browse", "other"]);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function normalizeRequest(raw, catalog) {
  const r = raw && typeof raw === "object" ? raw : {};
  const items = [];
  const unmatched = [];
  for (const label of Array.isArray(r.items) ? r.items : []) {
    const hit = findItem(catalog, label);
    if (hit) {
      if (!items.includes(hit)) items.push(hit);
    } else if (str(label)) unmatched.push(str(label));
  }
  for (const phrase of Array.isArray(r.unmatched) ? r.unmatched : []) if (str(phrase)) unmatched.push(str(phrase));

  const ambiguous = (Array.isArray(r.ambiguous) ? r.ambiguous : [])
    .map((a) => ({ phrase: str(a?.phrase) || "that", options: (a?.options || []).map((o) => findItem(catalog, o)).filter(Boolean) }))
    .filter((a) => a.options.length > 0);

  let start = hhmmToMin(r.start);
  let end = hhmmToMin(r.end);
  if (start == null || end == null || end <= start) {
    start = null;
    end = null;
  }

  const appliances = {};
  const raws = r.appliances && typeof r.appliances === "object" ? r.appliances : {};
  for (const a of APPLIANCES) {
    const v = raws[a.key];
    if (a.kind === "bool" && v === true) appliances[a.key] = true;
    if (a.kind === "count" && Number.isInteger(v) && v > 0) appliances[a.key] = v;
  }

  return {
    intent: INTENTS.has(r.intent) ? r.intent : "other",
    items,
    unmatched,
    ambiguous,
    date: ISO.test(r.date || "") ? r.date : null,
    toDate: ISO.test(r.toDate || "") ? r.toDate : null,
    start,
    end,
    title: str(r.title),
    ministry: str(r.ministry),
    appliances,
    search: str(r.search)?.slice(0, 60) ?? null,
  };
}

const CHATTER = /^(thanks?( you)?( so much)?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|perfect|yes|yep|yeah|no|nope|lol|ha(ha)+|sounds good|got it|will do|np|no problem)$/;

// #reservations is read whole, so obvious chatter is dropped before it costs
// a model call. Anything less obvious goes to the parser, which says "other".
export function isIgnorableChatter(text) {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !t || CHATTER.test(t);
}

export function missingFields(req) {
  const missing = [];
  if (req.items.length === 0) missing.push("what to book");
  if (!req.date) missing.push("date");
  if (req.start == null) missing.push("start and end time");
  if (!req.title) missing.push("what it's for");
  return missing;
}
