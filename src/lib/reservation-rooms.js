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
    // substring: a known canonical/alias token appears inside noisy free text
    for (const [key, canon] of canonByNorm) if (norm.includes(key)) return canon;
    for (const [key, canon] of aliasByNorm) if (norm.includes(key)) return canon;
    return null;
  }
  return { match };
}
