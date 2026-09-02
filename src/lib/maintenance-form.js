export const SUBMIT_ACTION_ID = "submit_maintenance_form";
export const CANCEL_ACTION_ID = "cancel_maintenance_form";

export const ISSUE_TYPES = [
  "Lighting",
  "Elevator",
  "Pest Control",
  "Electrical",
  "Plumbing",
  "HVAC",
  "Janitorial",
  "Other",
];

export const SEVERITIES = ["Minor", "Medium", "Critical"];

function selectOptions(values) {
  return values.map((v) => ({
    text: { type: "plain_text", text: v },
    value: v,
  }));
}

// Slack requires initial_option to be one of the options by identity of value,
// so build it from the same list rather than constructing a fresh object. An
// unrecognised guess is dropped and the select comes up empty.
function selectElement(actionId, values, placeholder, initialValue) {
  const options = selectOptions(values);
  const initialOption = options.find((o) => o.value === initialValue);
  return {
    type: "static_select",
    action_id: actionId,
    placeholder: { type: "plain_text", text: placeholder },
    options,
    ...(initialOption ? { initial_option: initialOption } : {}),
  };
}

export function buildMaintenanceFormBlocks(
  initialDescription,
  duplicate,
  reporterId,
  prefill = {}
) {
  const descriptionElement = {
    type: "plain_text_input",
    action_id: "description",
    multiline: true,
    ...(initialDescription ? { initial_value: initialDescription } : {}),
  };

  const typeElement = selectElement("type", ISSUE_TYPES, "Select a type", prefill.type);
  const severityElement = selectElement(
    "severity",
    SEVERITIES,
    "Select severity",
    prefill.severity
  );

  // Name the fields that were guessed, so a wrong guess reads as something to
  // correct rather than as a value the reporter chose and forgot about.
  const guessed = [
    typeElement.initial_option ? "type" : null,
    severityElement.initial_option ? "severity" : null,
  ].filter(Boolean);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Thanks for reporting an issue${reporterId ? `, <@${reporterId}>` : ""}! Please fill out the details below and hit Submit.`,
      },
    },
    ...(duplicate
      ? [
          {
            type: "section",
            block_id: "duplicate_warning",
            text: {
              type: "mrkdwn",
              text: `:warning: This might be a duplicate of issue #${duplicate.id} — *${duplicate.description}*. If it's the same problem, hit Cancel.`,
            },
          },
        ]
      : []),
    ...(guessed.length
      ? [
          {
            type: "context",
            block_id: "prefill_note",
            elements: [
              {
                type: "mrkdwn",
                text: `I guessed the ${guessed.join(" and ")} from your message — please correct ${guessed.length > 1 ? "them" : "it"} if I got ${guessed.length > 1 ? "them" : "it"} wrong.`,
              },
            ],
          },
        ]
      : []),
    {
      type: "input",
      block_id: "issue_description",
      label: { type: "plain_text", text: "Issue" },
      element: descriptionElement,
    },
    {
      type: "input",
      block_id: "issue_type",
      label: { type: "plain_text", text: "Type" },
      element: typeElement,
    },
    {
      type: "input",
      block_id: "issue_severity",
      label: { type: "plain_text", text: "Severity" },
      element: severityElement,
    },
    {
      type: "actions",
      block_id: "submit_actions",
      elements: [
        {
          type: "button",
          action_id: SUBMIT_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: "Submit" },
        },
        {
          type: "button",
          action_id: CANCEL_ACTION_ID,
          text: { type: "plain_text", text: "Cancel" },
          confirm: {
            title: { type: "plain_text", text: "Discard this report?" },
            text: {
              type: "plain_text",
              text: "The form and anything you've entered will be removed.",
            },
            confirm: { type: "plain_text", text: "Discard" },
            deny: { type: "plain_text", text: "Keep editing" },
            style: "danger",
          },
        },
      ],
    },
  ];
}

export function extractFormValues(stateValues) {
  const description =
    (stateValues?.issue_description?.description?.value || "").trim() || null;
  const type =
    stateValues?.issue_type?.type?.selected_option?.value || null;
  const severity =
    stateValues?.issue_severity?.severity?.selected_option?.value || null;
  return { description, type, severity };
}
