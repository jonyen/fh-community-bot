export function parseTimeToMinutes(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  const min = Number(m[2]);
  if (m[3].toLowerCase() === "pm") hour += 12;
  return hour * 60 + min;
}

export function formatMinutes(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function parseMonthDay(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]) };
}

export function inferYear(month, day, referenceDate) {
  const refYear = referenceDate.getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1];
  let best = refYear;
  let bestDist = Infinity;
  for (const y of candidates) {
    const d = Date.UTC(y, month - 1, day);
    const dist = Math.abs(d - referenceDate.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

export function isAllDay(startMin, endMin) {
  return startMin === 0 && endMin === 23 * 60 + 59;
}
