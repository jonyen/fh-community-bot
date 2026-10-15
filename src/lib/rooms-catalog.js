// src/lib/rooms-catalog.js
// The room request sheet is typed by hand, so one room shows up as "MPR",
// "FH MPR" and "MPR, parking lot". Every alias here is lowercase with any
// leading "FH " already stripped. The kitchen is booked on its own sheet, so
// it is not a room here.
export const ALL_FH = "All FH";

export const ROOMS = [
  { name: "L120", aliases: ["l120", "ll120", "120", "1st floor suite", "l120: 1st floor suite"] },
  { name: "MPR", aliases: ["mpr", "multipurpose room", "multi-purpose room"] },
  { name: "Makerspace", aliases: ["makerspace", "maker space"] },
  { name: "Youth Room", aliases: ["youth room", "240", "240: youth room"] },
  { name: "A2K Room", aliases: ["a2k room", "a2k", "220", "220: a2k room"] },
  { name: "Childcare Room", aliases: ["childcare room", "childcare", "230", "230: childcare room"] },
  { name: "Dining Room", aliases: ["dining room", "dining", "200: dining room"] },
  { name: "Conference Room", aliases: ["conference room", "200: conference room"] },
  { name: "Glass Room", aliases: ["glass room", "glass conference room", "300", "300: glass conference room"] },
  { name: "Staff Suite", aliases: ["staff suite", "302", "302: staff suite"] },
  { name: "Parking Lot", aliases: ["parking lot", "parking"] },
];

const BY_ALIAS = new Map(ROOMS.flatMap((r) => [[r.name.toLowerCase(), r.name], ...r.aliases.map((a) => [a, r.name])]));

// Longest aliases first, so "glass conference room" wins over "300".
const ALIASES_BY_LENGTH = [...BY_ALIAS.keys()].sort((a, b) => b.length - a.length);

function cleanKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/^fh[\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeRoom(text) {
  const raw = String(text || "").trim();
  const key = cleanKey(raw);
  if (key === "all fh" || key === "all") return ALL_FH;
  if (BY_ALIAS.has(key)) return BY_ALIAS.get(key);
  // "Multipurpose Room (MPR)" -> try the parenthetical too.
  const inner = raw.match(/\(([^)]*)\)/)?.[1];
  if (inner && BY_ALIAS.has(cleanKey(inner))) return BY_ALIAS.get(cleanKey(inner));
  // "Youth Room 240": a known name inside extra words.
  const hit = ALIASES_BY_LENGTH.find((a) => new RegExp(`(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(key));
  return hit ? BY_ALIAS.get(hit) : raw;
}

export function splitRooms(cell) {
  return String(cell || "")
    .split(/[\n,;/&+]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeRoom);
}

export function roomsConflict(a, b) {
  if (a.includes(ALL_FH) || b.includes(ALL_FH)) return a.length > 0 && b.length > 0;
  return a.some((r) => b.includes(r));
}
