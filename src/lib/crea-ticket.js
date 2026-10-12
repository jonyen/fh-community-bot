import { formBlockId } from "./maintenance-form.js";

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

export const CREA_SEND_ACTION_ID = "send_crea_ticket";
export const CREA_CANCEL_ACTION_ID = "cancel_crea_ticket";

// Slack caps a plain_text_input's initial_value at 3000 characters; the
// portal caps the free-text title at 225.
const DESCRIPTION_INPUT_MAX = 3000;
const TITLE_INPUT_MAX = 225;

// The draft CREA ticket posted in the report's thread. Nothing reaches the
// portal until someone on the allowlist presses Send, and what is sent is
// whatever the fields hold at that moment. The portal only takes a free-text
// title for "Other"; every other type is filed under the type's own name, so
// the title field only appears for "Other".
//
// Block ids are scoped to the thread, for the reason given at formBlockId:
// Slack keeps input state by block_id, and a shared id would carry one
// draft's edits into the next.
export function buildCreaDraftBlocks({ title, description, type, severity, reporter, photoCount = 0, requesterId, draftKey }) {
  const id = (name) => formBlockId(name, draftKey);
  const isOther = !type || type === "Other";
  const added = [
    `Filed as *${isOther ? "Other" : type}*`,
    severity ? `Severity: ${severity}` : null,
    reporter ? `Reported by: ${reporter}` : null,
    photoCount ? `${photoCount} photo(s) attached` : null,
  ].filter(Boolean);

  return [
    {
      type: "section",
      block_id: id("crea_intro"),
      text: {
        type: "mrkdwn",
        text: `Draft ticket for CREA${requesterId ? `, requested by <@${requesterId}>` : ""}. Edit it if needed, then hit *Send to CREA*. Nothing is sent until then.`,
      },
    },
    ...(isOther
      ? [
          {
            type: "input",
            block_id: id("crea_title"),
            label: { type: "plain_text", text: "Title" },
            element: {
              type: "plain_text_input",
              action_id: "crea_title",
              max_length: TITLE_INPUT_MAX,
              ...(title ? { initial_value: title.slice(0, TITLE_INPUT_MAX) } : {}),
            },
          },
        ]
      : []),
    {
      type: "input",
      block_id: id("crea_description"),
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "plain_text_input",
        action_id: "crea_description",
        multiline: true,
        max_length: DESCRIPTION_INPUT_MAX,
        ...(description ? { initial_value: description.slice(0, DESCRIPTION_INPUT_MAX) } : {}),
      },
    },
    {
      type: "context",
      block_id: id("crea_meta"),
      elements: [{ type: "mrkdwn", text: added.join(" · ") }],
    },
    {
      type: "actions",
      block_id: id("crea_actions"),
      elements: [
        {
          type: "button",
          action_id: CREA_SEND_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Send to CREA" },
          confirm: {
            title: { type: "plain_text", text: "Send this to CREA?" },
            text: { type: "plain_text", text: "It goes to the landlord's tenant portal and can't be taken back from here." },
            confirm: { type: "plain_text", text: "Send" },
            deny: { type: "plain_text", text: "Keep editing" },
          },
        },
        {
          type: "button",
          action_id: CREA_CANCEL_ACTION_ID,
          text: { type: "plain_text", text: "Cancel" },
        },
      ],
    },
  ];
}

export function extractCreaDraftValues(stateValues) {
  const byAction = {};
  for (const block of Object.values(stateValues || {})) {
    for (const [actionId, state] of Object.entries(block || {})) {
      byAction[actionId] = state;
    }
  }
  return {
    title: (byAction.crea_title?.value || "").trim() || null,
    description: (byAction.crea_description?.value || "").trim() || null,
  };
}
