import { inferYear } from "./reservation-time.js";

const TAB_RE = /^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2}) (M-F|S-Su)$/;

export function parseTabName(name) {
  const m = String(name).trim().match(TAB_RE);
  if (!m) return null;
  return {
    start: { month: Number(m[1]), day: Number(m[2]) },
    end: { month: Number(m[3]), day: Number(m[4]) },
    kind: m[5],
  };
}

export function isScheduleTab(name) {
  return parseTabName(name) !== null;
}

export function selectTabForDate(tabNames, date) {
  const t = date.getTime();
  for (const name of tabNames) {
    const parsed = parseTabName(name);
    if (!parsed) continue;
    const startYear = inferYear(parsed.start.month, parsed.start.day, date);
    let start = Date.UTC(startYear, parsed.start.month - 1, parsed.start.day);
    let endYear = inferYear(parsed.end.month, parsed.end.day, date);
    let end = Date.UTC(endYear, parsed.end.month - 1, parsed.end.day, 23, 59, 59);
    if (end < start) {
      endYear += 1;
      end = Date.UTC(endYear, parsed.end.month - 1, parsed.end.day, 23, 59, 59);
    }
    if (t >= start && t <= end) return name;
  }
  return null;
}
