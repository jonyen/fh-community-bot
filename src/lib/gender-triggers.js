export const GENDER_TRIGGER_RE = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/i;
export const GENDER_REFRESH_RE = /(?:^|\s)[!@]refresh-genders\b/i;

const MALE_ALIASES = new Set(["bros", "brothers"]);
const FEMALE_ALIASES = new Set(["sis", "sisters"]);

export function matchesGenderEvent(text) {
  if (!text) return false;
  return GENDER_TRIGGER_RE.test(text) || GENDER_REFRESH_RE.test(text);
}

export function resolveTarget(text) {
  if (!text) return null;
  const matches = new Set();
  const re = /(?:^|\s)[!@](bros|brothers|sis|sisters)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.add(m[1].toLowerCase());
  }
  if (matches.size === 0) return null;
  for (const a of matches) if (MALE_ALIASES.has(a)) return "male";
  for (const a of matches) if (FEMALE_ALIASES.has(a)) return "female";
  return null;
}
