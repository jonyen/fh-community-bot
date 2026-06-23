const PATTERNS = [
  /\b(reserve|reservation|reservations|book|booking)\b/i,
  /\bavailab(le|ility)\b/i,
  /\bis\b.+\bfree\b/i,
  /\bwhen is\b.+\b(used|using|booked|reserved|free)\b/i,
];

export function matchesReservationIntent(text) {
  const t = String(text || "");
  return PATTERNS.some((p) => p.test(t));
}
