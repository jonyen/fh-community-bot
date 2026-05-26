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
