export const SEVERITY_OPTIONS = ["minor", "medium", "critical"];

export function extractSeverity(text) {
  // Match patterns like "- critical", "critical priority", "severity: minor", "medium severity", or trailing "critical"
  const match = text.match(
    /[\s,\-\|]+(?:severity[:\s]+)?(minor|medium|critical)(?:\s+(?:priority|severity|issue))?\s*$|[\s,\-\|]+(minor|medium|critical)\s+(?:priority|severity)\s*$/i
  );
  if (!match) return { description: text, severity: null };
  const severity = (match[1] || match[2])
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
  const description = text.slice(0, match.index).trim().replace(/[:\-\|,]+$/, "").trim();
  return { description, severity };
}

// Parse a free-form reply to the "how severe is this?" prompt. Unlike
// extractSeverity (which only matches a severity in the trailing/suffix
// position of an inline report), this accepts a severity keyword anywhere in
// the reply, so answers like "Medium but important to do it soon" are
// understood. Returns the capitalized severity, or null if no severity — or
// more than one distinct severity — is found.
export function parseSeverityReply(text) {
  const found = new Set();
  for (const m of (text || "").matchAll(/\b(minor|medium|critical)\b/gi)) {
    found.add(m[1].toLowerCase());
  }
  if (found.size !== 1) return null;
  const [severity] = found;
  return severity.replace(/^./, (c) => c.toUpperCase());
}
