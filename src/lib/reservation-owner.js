// src/lib/reservation-owner.js
// Decides whether a listed reservation belongs to a Slack member, and gives
// each booking a stable key so the bot can remember the ones it made.
export function normalizeName(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-guess match of a sheet's free-text name against one candidate name.
function matchesCandidate(sheet, cand) {
  if (!sheet || !cand) return false;
  if (sheet === cand) return true;
  const c = cand.split(" ");
  if (c.length < 2) return false;
  const s = sheet.split(" ");
  if (` ${sheet} `.includes(` ${cand} `)) return true;
  const [cFirst, cLast] = [c[0], c[c.length - 1]];
  if (s.length >= 2) {
    const [sFirst, sLast] = [s[0], s[s.length - 1]];
    if (sFirst === cFirst && sLast === cLast) return true;
    if (sFirst === cLast && sLast === cFirst) return true;
  }
  return s.length === 2 && s[1].length === 1 && s[0] === cFirst && s[1] === cLast[0];
}

export function namesMatch(sheetName, member) {
  const sheet = normalizeName(sheetName);
  // A first name alone never matches, even when it is the whole display or real name.
  if (sheet && !sheet.includes(" ") && sheet === normalizeName(member?.realName).split(" ")[0]) return false;
  return [member?.realName, member?.displayName].some((n) => matchesCandidate(sheet, normalizeName(n)));
}

// The rooms key without its rooms: what keys looked like before rooms were
// part of them, so a ref stored without rooms still matches.
function roomsLegacyKey(ref) {
  return `rooms:${ref.date}:${ref.start}:${ref.end}:${normalizeName(ref.title)}:${normalizeName(ref.holder)}`;
}

export function refKey(ref) {
  if (!ref) return "";
  if (ref.backend === "rms") return `rms:${ref.eventId}`;
  if (ref.backend === "rooms") {
    // Two rows alike but for their rooms are two bookings.
    if (!Array.isArray(ref.rooms)) return roomsLegacyKey(ref);
    const rooms = ref.rooms.map((r) => String(r).trim().toLowerCase()).sort().join("|");
    return `${roomsLegacyKey(ref)}:${rooms}`;
  }
  if (ref.backend === "kitchen") return `kitchen:${ref.row}:${ref.date}:${normalizeName(ref.name)}`;
  return "";
}

// Whether a set of refKeys holds this ref, by its key or (for a ref stored
// before rooms were in the key) by the key without rooms.
export function hasRefKey(keys, ref) {
  const key = refKey(ref);
  if (!key || !keys) return false;
  return keys.has(key) || (ref.backend === "rooms" && keys.has(roomsLegacyKey(ref)));
}

// Whether two refs name the same booking; a rooms ref without rooms on
// either side is compared without them.
export function sameRef(a, b) {
  const ka = refKey(a);
  if (!ka || !b) return false;
  if (ka === refKey(b)) return true;
  return a.backend === "rooms" && b.backend === "rooms" && (!Array.isArray(a.rooms) || !Array.isArray(b.rooms))
    && roomsLegacyKey(a) === roomsLegacyKey(b);
}

const last10 = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);

export function isMine(reservation, member, ledgerKeys) {
  if (hasRefKey(ledgerKeys, reservation.ref)) return true;
  if (reservation.holderUserId && reservation.holderUserId === member.userId) return true;
  const email = String(member.email ?? "").toLowerCase();
  if (email && String(reservation.holderEmail ?? "").toLowerCase() === email) return true;
  if (reservation.category === "kitchen") {
    const theirs = last10(reservation.phone);
    if (theirs.length >= 7 && theirs === last10(member.phone)) return true;
  }
  if (reservation.category === "rooms" || reservation.category === "kitchen") {
    return namesMatch(reservation.holderName, member);
  }
  return false;
}
