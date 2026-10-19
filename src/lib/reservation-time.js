// src/lib/reservation-time.js
// Dates are "YYYY-MM-DD" strings and times are minutes after midnight, both
// in New York time. Lambda runs in UTC, so nothing here trusts the host zone.
export const TZ = "America/New_York";

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");

function utcNoon(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

export function addDaysIso(iso, n) {
  const d = utcNoon(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validIso(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const back = utcNoon(iso);
  return back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? iso : null;
}

// "Tue, 6/23/26", "6/23/2026", or the kitchen sheet's yearless "Thu, 09/03".
// A yearless date more than 180 days before refIso belongs to next year: the
// kitchen sheet rolls forward, so in December "01/07" means January coming.
export function parseSheetDate(text, refIso) {
  const m = String(text || "").match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (m[3]) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validIso(year, month, day);
  }
  const refYear = Number(refIso.slice(0, 4));
  const iso = validIso(refYear, month, day);
  if (!iso) return null;
  const ageDays = (utcNoon(refIso) - utcNoon(iso)) / 86400000;
  return ageDays > 180 ? validIso(refYear + 1, month, day) : iso;
}

export function formatSheetDate(iso) {
  const d = utcNoon(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`;
}

// "6:00:00 PM", "9:00 PM", "18:30" -> minutes. Anything else -> null.
export function parseSheetTime(text) {
  const m = String(text || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].toUpperCase() === "PM";
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

export function hhmmToMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function hm(min) {
  // 1440 is midnight at the end of the day (events that run until midnight).
  const h24 = Math.floor(min / 60) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return { text: `${h}:${pad(min % 60)}`, ampm: h24 < 12 ? "AM" : "PM" };
}

export function fmtTime(min) {
  const t = hm(min);
  return `${t.text} ${t.ampm}`;
}

export function fmtRange(start, end) {
  if (start == null || end == null) return "All day";
  const a = hm(start);
  const b = hm(end);
  return a.ampm === b.ampm ? `${a.text}–${b.text} ${b.ampm}` : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
}

// Null times mean all day.
export function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = aStart ?? 0, ae = aEnd ?? 1440, bs = bStart ?? 0, be = bEnd ?? 1440;
  return as < be && bs < ae;
}

export function nyOffset(iso) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(utcNoon(iso));
  const name = parts.find((p) => p.type === "timeZoneName").value; // "GMT-04:00"
  return name === "GMT" ? "+00:00" : name.slice(3);
}

export function nyLocal(iso, min) {
  return `${iso}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
}

export function nyDateTime(iso, min) {
  return `${nyLocal(iso, min)}${nyOffset(iso)}`;
}

export function nyParts(dateTime) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(dateTime)).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function nyToday(now = new Date()) {
  return nyParts(now.toISOString()).date;
}

export function weekOf(now = new Date()) {
  const today = nyToday(now);
  const dow = utcNoon(today).getUTCDay(); // 0 = Sunday
  const from = addDaysIso(today, dow === 0 ? -6 : 1 - dow);
  return { from, to: addDaysIso(from, 6) };
}

// Digests split the week in two: Mon–Thu ("weekday") and Fri–Sun ("weekend").
export function digestPeriod(kind, now = new Date()) {
  const { from: monday } = weekOf(now);
  return kind === "weekend"
    ? { kind, from: addDaysIso(monday, 4), to: addDaysIso(monday, 6) }
    : { kind: "weekday", from: monday, to: addDaysIso(monday, 3) };
}

// The period a date falls in.
export function periodCovering(iso) {
  const dow = utcNoon(iso).getUTCDay();
  const weekend = dow === 0 || dow >= 5;
  return digestPeriod(weekend ? "weekend" : "weekday", utcNoon(iso));
}

export function fmtDay(iso) {
  const d = utcNoon(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function weekdayName(iso) {
  return WEEKDAYS_LONG[utcNoon(iso).getUTCDay()];
}
