export const GENDER_TRIGGER_RE = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/i;
export const GENDER_REFRESH_RE = /(?:^|\s)[!@]refresh-genders\b/i;

const MALE_ALIASES = new Set(["bros", "brothers"]);
const TRIGGER_GLOBAL_RE = /(^|\s)[!@](bros|brothers|sis|sisters)\b/gi;

function aliasToGender(alias) {
  return MALE_ALIASES.has(alias.toLowerCase()) ? "male" : "female";
}

export function matchesGenderEvent(text) {
  if (!text) return false;
  return GENDER_TRIGGER_RE.test(text);
}

export function referencedGenders(text) {
  const seen = new Set();
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(TRIGGER_GLOBAL_RE)) {
    const g = aliasToGender(m[2]);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}
