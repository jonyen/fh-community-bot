// Reacting to a logged report with one of these files it with CREA, the
// landlord. 🎫 is :ticket:, 🎟️ is :admission_tickets:.
export const CREA_TICKET_REACTIONS = new Set(["ticket", "admission_tickets"]);

// The bot puts this on the report's thread root once it takes a ticket
// request. Slack refuses a second identical reaction from the same user
// (already_reacted), which makes it an atomic claim: two people reacting at
// once, or Slack redelivering the event, can't file the issue twice.
export const CREA_CLAIM_REACTION = "incoming_envelope";

export function isCreaTicketReaction(name) {
  // Skin-tone and other modifiers arrive as "name::modifier".
  return CREA_TICKET_REACTIONS.has((name || "").split("::")[0]);
}

// The portal has no severity field, so severity and the Slack reporter ride
// along in the description.
export function buildCreaDescription({ description, severity, reporter }) {
  const lines = [description];
  const meta = [];
  if (severity) meta.push(`Severity: ${severity}`);
  if (reporter) meta.push(`Reported by: ${reporter}`);
  if (meta.length) lines.push("", ...meta);
  return lines.join("\n");
}

// Only used when the type is "Other", where the portal wants a free-text title.
export function buildCreaTitle(description) {
  const firstLine = description.split("\n")[0].trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}
