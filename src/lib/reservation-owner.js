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

export function refKey(ref) {
  if (!ref) return "";
  if (ref.backend === "rms") return `rms:${ref.eventId}`;
  if (ref.backend === "rooms") {
    return `rooms:${ref.date}:${ref.start}:${ref.end}:${normalizeName(ref.title)}:${normalizeName(ref.holder)}`;
  }
  if (ref.backend === "kitchen") return `kitchen:${ref.row}:${ref.date}:${normalizeName(ref.name)}`;
  return "";
}

const last10 = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);

export function isMine(reservation, member, ledgerKeys) {
  const key = refKey(reservation.ref);
  if (key && ledgerKeys?.has(key)) return true;
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
