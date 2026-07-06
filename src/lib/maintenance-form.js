export const SUBMIT_ACTION_ID = "submit_maintenance_form";

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

export function buildMaintenanceFormBlocks(initialDescription) {
  const descriptionElement = {
    type: "plain_text_input",
    action_id: "description",
    multiline: true,
    ...(initialDescription ? { initial_value: initialDescription } : {}),
  };

  return [
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
