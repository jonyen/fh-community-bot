export const GENDER_TRIGGER_RE = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/i;
export const GENDER_REFRESH_RE = /(?:^|\s)[!@]refresh-genders\b/i;

const MALE_ALIASES = new Set(["bros", "brothers"]);
const TRIGGER_GLOBAL_RE = /(^|\s)[!@](bros|brothers|sis|sisters)\b/gi;
const REFRESH_STRIP_RE = /(?:^|\s)[!@]refresh-genders\b/gi;

function aliasToGender(alias) {
  return MALE_ALIASES.has(alias.toLowerCase()) ? "male" : "female";
}

export function matchesGenderEvent(text) {
  if (!text) return false;
  return GENDER_TRIGGER_RE.test(text);
}

export function referencedGenders(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of text.matchAll(TRIGGER_GLOBAL_RE)) {
    out.add(aliasToGender(m[2]));
  }
  return out;
}

export function formatGenderReply(text, mentionsByGender) {
  if (!text) {
    return Object.values(mentionsByGender).filter(Boolean).join(" ");
  }
  let out = "";
  let cursor = 0;
  for (const m of text.matchAll(TRIGGER_GLOBAL_RE)) {
    const lead = m[1];
    const gender = aliasToGender(m[2]);
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    out += text.slice(cursor, start);
    const ids = mentionsByGender[gender];
    if (ids) out += ids;
    cursor = end;
  }
  out += text.slice(cursor);
  return out.replace(REFRESH_STRIP_RE, " ").replace(/\s+/g, " ").trim();
}
