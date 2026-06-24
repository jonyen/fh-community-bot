export function normalizeLocation(str) {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function createRoomMatcher(canonicalRooms, aliases = {}) {
  const canonByNorm = new Map();
  for (const room of canonicalRooms) canonByNorm.set(normalizeLocation(room), room);
  const aliasByNorm = new Map();
  for (const [alias, canon] of Object.entries(aliases)) aliasByNorm.set(normalizeLocation(alias), canon);

  function match(location) {
    const norm = normalizeLocation(location);
    if (!norm) return null;
    if (canonByNorm.has(norm)) return canonByNorm.get(norm);
    if (aliasByNorm.has(norm)) return aliasByNorm.get(norm);
    // (a) a known canonical/alias name appears inside noisy free text — this is
    // the sheet LOCATION case, e.g. "FH MPR (100)" contains "FH MPR".
    for (const [key, canon] of canonByNorm) if (norm.includes(key)) return canon;
    for (const [key, canon] of aliasByNorm) if (norm.includes(key)) return canon;
    // (b) the query is a whole word inside a canonical name — this is the user
    // query case, e.g. "MPR" → "FH MPR", "Staff Suite" → "FH 302: Staff Suite".
    const wordRe = new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const [key, canon] of canonByNorm) if (wordRe.test(key)) return canon;
    for (const [key, canon] of aliasByNorm) if (wordRe.test(key)) return canon;
    return null;
  }
  return { match };
}
