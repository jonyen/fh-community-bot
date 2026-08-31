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

export function buildMaintenanceFormBlocks(initialDescription, duplicate, reporterId) {
  const descriptionElement = {
    type: "plain_text_input",
    action_id: "description",
    multiline: true,
    ...(initialDescription ? { initial_value: initialDescription } : {}),
  };

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
      element: {
        type: "static_select",
        action_id: "type",
        placeholder: { type: "plain_text", text: "Select a type" },
        options: selectOptions(ISSUE_TYPES),
      },
    },
    {
      type: "input",
      block_id: "issue_severity",
      label: { type: "plain_text", text: "Severity" },
      element: {
        type: "static_select",
        action_id: "severity",
        placeholder: { type: "plain_text", text: "Select severity" },
        options: selectOptions(SEVERITIES),
      },
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
