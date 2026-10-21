// src/lib/reservation-tray.js
// The tray: items a member has collected in #reservations, each a line with its
// own date, time, title and optional weekly repeat, reserved all at once.
// Pure model, no I/O. Dates are "YYYY-MM-DD", times are minutes after midnight.
//
//   Line = { id, item /* catalog label */, date: ISO|null, start: number|null,
//            end: number|null, title: string|null, appliances: object,
//            repeat: null | { days: number[] /* 0 = Sun */, until: ISO|null },
//            onlyDates: ISO[]|null /* repeat dates still wanted */,
//            progress: { [ISO]: "started"|"done" },
//            claims?: { [ISO]: runId } /* the Reserve all run that marked it */,
//            booked?: { [ISO]: ref } /* refs of "done" dates, until posted */ }
//   Tray = { version, lines: Line[], view: { q, c /* "all" or category id */, p },
//            editing: Line|null /* the draft being edited */,
//            running: { runId, at } | null,
//            posts?: { [runId]: { ts, entries, ledger } } /* posted, not yet tidied */,
//            ended?: { [runId]: ms } /* runs ended or taken over; a redelivery stops */ }
import { randomBytes } from "node:crypto";
import { findItem } from "./reservation-catalog.js";
import { addDaysIso, fmtDay, fmtRange } from "./reservation-time.js";

export const MAX_LINES = 10;
export const MAX_DATES = 60;
export const MAX_REPEAT_DAYS = 183; // about 6 months
export const TRAY_TTL_S = 86400;

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const randomId = () => randomBytes(4).toString("hex");
// Trays come back from storage, so do not trust the shape of days.
const daysOf = (repeat) => (Array.isArray(repeat?.days) ? repeat.days : []);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

export function emptyTray() {
  return { version: 1, lines: [], view: { q: "", c: "all", p: 0 }, editing: null, running: null };
}

// A new line starts from the previous one's when and what-for: collecting
// several items for one event should not mean typing it again.
export function newLine(itemLabel, prev, makeId = randomId) {
  return {
    id: makeId(),
    item: itemLabel,
    date: prev?.date ?? null,
    start: prev?.start ?? null,
    end: prev?.end ?? null,
    title: prev?.title ?? null,
    appliances: {},
    repeat: prev?.repeat ? { ...prev.repeat, days: [...daysOf(prev.repeat)] } : null,
    onlyDates: null,
    progress: {},
  };
}

export function expandDates(line) {
  if (!line.date) return [];
  if (!line.repeat) return [line.date];
  const days = daysOf(line.repeat);
  const { until } = line.repeat;
  const out = [];
  // Bounded, so a bad until cannot loop forever.
  for (let d = line.date, n = 0; until && d <= until && n <= MAX_REPEAT_DAYS * 2; d = addDaysIso(d, 1), n++) {
    if (days.includes(weekday(d)) && (!line.onlyDates || line.onlyDates.includes(d))) out.push(d);
  }
  return out;
}

export function lineProblems(line, { today, nowMin, catalog }) {
  const out = [];
  if (!findItem(catalog, line.item)) out.push(`${line.item} can no longer be booked.`);
  if (!line.date) out.push("Pick a date.");
  if (line.start == null || line.end == null) out.push("Pick a start and end time.");
  else if (line.end <= line.start) out.push("End must be after start.");
  if (!line.title) out.push("Add what it's for.");
  if (line.date && line.date < today) out.push("That date has passed.");
  else if (line.date === today && line.start != null && line.start < nowMin) out.push("That time has already passed today.");
  if (line.repeat) {
    const days = daysOf(line.repeat);
    const { until } = line.repeat;
    if (!days.length) out.push("Pick at least one day to repeat on.");
    // The first date is the line's date, so it must be one of the repeat days.
    if (days.length && line.date && !days.includes(weekday(line.date))) out.push("Pick a date that falls on one of the repeat days.");
    if (!until) out.push("Pick when the repeat ends.");
    else if (line.date && until <= line.date) out.push("The repeat must end after its first date.");
    else if (line.date && until > addDaysIso(line.date, MAX_REPEAT_DAYS)) out.push("Repeats can run at most 6 months.");
  }
  return out;
}

export function trayProblems(tray, ctx) {
  const out = tray.lines.flatMap((l) => lineProblems(l, ctx).map((p) => `${l.item}: ${p}`));
  if (tray.lines.length > MAX_LINES) out.push(`Your tray has more than ${MAX_LINES} lines.`);
  const dates = tray.lines.reduce((n, l) => n + expandDates(l).length, 0);
  if (dates > MAX_DATES) out.push(`That's ${dates} dates; Reserve all can do at most ${MAX_DATES} at once.`);
  return out;
}

export function repeatText(repeat, untilFmt = fmtDay) {
  // Monday first, so a weekend repeat reads "Sat, Sun".
  const names = [...daysOf(repeat)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS_SHORT[d]);
  return `every ${names.join(", ")}${repeat.until ? ` until ${untilFmt(repeat.until)}` : ""}`;
}

export function lineSummary(line) {
  const day = line.date ? fmtDay(line.date) : "_day?_";
  const time = line.start != null && line.end != null ? fmtRange(line.start, line.end) : "_time?_";
  const base = `${line.item} · ${day} · ${time} · ${line.title || "_what for?_"}`;
  return line.repeat ? `${base} · ${repeatText(line.repeat)} · ${expandDates(line).length} dates` : base;
}
