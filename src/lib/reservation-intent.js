const JUNK = [
  /^$/,
  /^(hi|hello|hey|yo|sup|hola|howdy|morning|gm)$/,
  /^(ok|okay|yes|no|yep|nope|sure|k)$/,
  /^(thanks|thank you|thx|ty|tysm|np)$/,
  /^(lol|lmao|haha|heh|hmm|wow|nice|cool|great|awesome)$/,
  /^[\p{Emoji}\s]+$/u,
];

export function isIgnorableChatter(text) {
  const t = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s\p{Emoji}]/gu, "").trim();
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

export function followUpText(missing) {
  const asks = missing.map((m) => LABELS[m]).filter(Boolean);
  let joined;
  if (asks.length <= 1) joined = asks[0] || "a few details";
  else joined = asks.slice(0, -1).join(", ") + " and " + asks[asks.length - 1];
  return `Happy to help with that — ${joined}?`;
}
