const JUNK = [
  /^$/,
  /^(hi|hello|hey|yo|sup|hola|howdy|morning|gm)$/,
  /^(ok|okay|yes|no|yep|nope|sure|k)$/,
  /^(thanks|thank you|thx|ty|tysm|np)$/,
  /^(lol|lmao|haha|heh|hmm|wow|nice|cool|great|awesome)$/,
  // Emoji-only messages. Use Extended_Pictographic, NOT \p{Emoji} — the latter
  // matches ASCII digits (0-9) and #/*, which would wrongly flag a bare "1"
  // (a disambiguation reply) as chatter and silently drop it.
  /^[\p{Extended_Pictographic}\s]+$/u,
];

export function isIgnorableChatter(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\p{Extended_Pictographic}]/gu, "")
    .trim();
  if (!t) return true;
  return JUNK.some((re) => re.test(t));
}

const LABELS = { room: "which room", date: "what date", time: "what time" };

export function missingSlots(parsed) {
  if (!parsed || (parsed.intent !== "reserve" && parsed.intent !== "check")) return [];
  const missing = [];
  if (!parsed.target) missing.push("room");
  if (!parsed.date) missing.push("date");
  if (!parsed.startTime || !parsed.endTime) missing.push("time");
  return missing;
}

// Parse the candidate labels out of a disambiguation ask the bot posted,
// e.g. "Which one did you mean: Tech Set 1, Tech Set 2, Tech Set 3?" → the list.
export function disambiguationCandidates(askText) {
  const m = /which one did you mean:\s*(.+?)\?/i.exec(String(askText || ""));
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

export function followUpText(missing) {
  const asks = missing.map((m) => LABELS[m]).filter(Boolean);
  let joined;
  if (asks.length <= 1) joined = asks[0] || "a few details";
  else joined = asks.slice(0, -1).join(", ") + " and " + asks[asks.length - 1];
  return `Happy to help with that — ${joined}?`;
}
