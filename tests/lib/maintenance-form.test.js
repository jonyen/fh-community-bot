import { describe, it, expect } from "vitest";
import {
  buildMaintenanceFormBlocks,
  extractFormValues,
  findFormBlock,
  formBlockId,
  isFormBlock,
  SUBMIT_ACTION_ID,
  CANCEL_ACTION_ID,
  ISSUE_TYPES,
  SEVERITIES,
} from "../../src/lib/maintenance-form.js";

describe("buildMaintenanceFormBlocks", () => {
  it("starts with an intro section thanking the reporter", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toMatch(/thanks for reporting/i);
  });

  it("mentions the reporter in the intro when a reporter id is passed", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", null, "U12345");
    expect(blocks[0].text.text).toContain("Thanks for reporting an issue, <@U12345>!");
  });

  it("keeps the plain intro when no reporter id is passed", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    expect(blocks[0].text.text).toContain("Thanks for reporting an issue!");
  });

  it("shows a duplicate warning block when a possible duplicate is passed", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", {
      id: "7",
      description: "leak under the sink",
    });
    const warning = findFormBlock(blocks, "duplicate_warning");
    expect(warning).toBeDefined();
    expect(warning.text.text).toContain("#7");
    expect(warning.text.text).toContain("leak under the sink");
    // Warning sits above the input fields
    const warningIdx = blocks.indexOf(warning);
    const descriptionIdx = blocks.indexOf(findFormBlock(blocks, "issue_description"));
    expect(warningIdx).toBeLessThan(descriptionIdx);
  });

  it("omits the duplicate warning block when no duplicate", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    expect(findFormBlock(blocks, "duplicate_warning")).toBeUndefined();
  });

  it("includes a cancel button alongside submit", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    const actions = findFormBlock(blocks, "submit_actions");
    const actionIds = actions.elements.map((e) => e.action_id);
    expect(actionIds).toContain(SUBMIT_ACTION_ID);
    expect(actionIds).toContain(CANCEL_ACTION_ID);
    const cancel = actions.elements.find((e) => e.action_id === CANCEL_ACTION_ID);
    expect(cancel.text.text).toBe("Cancel");
    expect(cancel.style).toBeUndefined();
  });

  it("asks for confirmation before cancelling", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    const actions = findFormBlock(blocks, "submit_actions");
    const cancel = actions.elements.find((e) => e.action_id === CANCEL_ACTION_ID);
    expect(cancel.confirm).toBeDefined();
    expect(cancel.confirm.title.text).toBeTruthy();
    expect(cancel.confirm.text.text).toBeTruthy();
    expect(cancel.confirm.confirm.text).toBeTruthy();
    expect(cancel.confirm.deny.text).toBeTruthy();
  });

  it("builds description, type, severity inputs and a submit button", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");

    const description = findFormBlock(blocks, "issue_description");
    expect(description.type).toBe("input");
    expect(description.element.type).toBe("plain_text_input");
    expect(description.element.action_id).toBe("description");
    expect(description.element.multiline).toBe(true);
    expect(description.element.initial_value).toBe("sink leaking");

    const type = findFormBlock(blocks, "issue_type");
    expect(type.element.type).toBe("static_select");
    expect(type.element.action_id).toBe("type");
    expect(type.element.options.map((o) => o.value)).toEqual(ISSUE_TYPES);

    const severity = findFormBlock(blocks, "issue_severity");
    expect(severity.element.type).toBe("static_select");
    expect(severity.element.action_id).toBe("severity");
    expect(severity.element.options.map((o) => o.value)).toEqual(SEVERITIES);

    const actions = findFormBlock(blocks, "submit_actions");
    expect(actions.type).toBe("actions");
    expect(actions.elements[0].action_id).toBe(SUBMIT_ACTION_ID);
  });

  it("omits initial_value when no description prefill", () => {
    const blocks = buildMaintenanceFormBlocks("");
    const description = findFormBlock(blocks, "issue_description");
    expect(description.element).not.toHaveProperty("initial_value");
  });

  it("leaves both selects empty when nothing was guessed", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");
    const type = findFormBlock(blocks, "issue_type");
    const severity = findFormBlock(blocks, "issue_severity");
    expect(type.element).not.toHaveProperty("initial_option");
    expect(severity.element).not.toHaveProperty("initial_option");
    expect(findFormBlock(blocks, "prefill_note")).toBeUndefined();
  });

  it("pre-selects the guessed type and severity", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", null, "U1", {
      type: "Plumbing",
      severity: "Minor",
    });

    const type = findFormBlock(blocks, "issue_type");
    expect(type.element.initial_option).toEqual({
      text: { type: "plain_text", text: "Plumbing" },
      value: "Plumbing",
    });
    // The initial option must be one of the offered options, or Slack rejects
    // the block outright.
    expect(type.element.options).toContainEqual(type.element.initial_option);

    const severity = findFormBlock(blocks, "issue_severity");
    expect(severity.element.initial_option.value).toBe("Minor");
    expect(severity.element.options).toContainEqual(severity.element.initial_option);
  });

  it("pre-selects only the field that was guessed", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", null, "U1", {
      type: "Plumbing",
      severity: null,
    });
    expect(findFormBlock(blocks, "issue_type").element.initial_option.value).toBe(
      "Plumbing"
    );
    expect(
      findFormBlock(blocks, "issue_severity").element
    ).not.toHaveProperty("initial_option");
  });

  it("ignores a guess that is not one of the offered options", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", null, "U1", {
      type: "Roofing",
      severity: "Catastrophic",
    });
    expect(findFormBlock(blocks, "issue_type").element).not.toHaveProperty(
      "initial_option"
    );
    expect(findFormBlock(blocks, "issue_severity").element).not.toHaveProperty(
      "initial_option"
    );
  });

  it("flags the guessed fields so a wrong guess reads as correctable", () => {
    const both = buildMaintenanceFormBlocks("sink leaking", null, "U1", {
      type: "Plumbing",
      severity: "Minor",
    }).find((b) => isFormBlock(b, "prefill_note"));
    expect(both.type).toBe("context");
    expect(both.elements[0].text).toContain("type and severity");

    const oneField = buildMaintenanceFormBlocks("sink leaking", null, "U1", {
      type: "Plumbing",
    }).find((b) => isFormBlock(b, "prefill_note"));
    expect(oneField.elements[0].text).toContain("type");
    expect(oneField.elements[0].text).not.toContain("severity");
  });

  it("keeps the prefill note above the inputs", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking", null, "U1", { type: "Plumbing" });
    expect(blocks.indexOf(findFormBlock(blocks, "prefill_note"))).toBeLessThan(
      blocks.indexOf(findFormBlock(blocks, "issue_description"))
    );
  });

  it("scopes every block_id to the form key so Slack cannot reuse another form's input state", () => {
    // Slack keys a message's input state by block_id. Two forms in one channel
    // with identical block_ids made the client show the previous report's
    // description in the new form.
    const a = buildMaintenanceFormBlocks("outlet cover popping out", null, "U1", {}, "1788883645.693749");
    const b = buildMaintenanceFormBlocks("leak in cold storage", null, "U2", {}, "1788529269.327099");
    const idsA = a.map((x) => x.block_id);
    const idsB = b.map((x) => x.block_id);
    expect(idsA.every((id) => id.endsWith(":1788883645.693749"))).toBe(true);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(findFormBlock(a, "issue_description").block_id).toBe(
      formBlockId("issue_description", "1788883645.693749")
    );
  });

  it("still produces unique block_ids when no form key is passed", () => {
    const a = buildMaintenanceFormBlocks("x").map((b) => b.block_id);
    const b = buildMaintenanceFormBlocks("x").map((b) => b.block_id);
    expect(a.every((id) => id.includes(":"))).toBe(true);
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
  });

  it("offers the expected issue types in order", () => {
    expect(ISSUE_TYPES).toEqual([
      "Lighting", "Elevator", "Pest Control", "Electrical",
      "Plumbing", "HVAC", "Janitorial", "Other",
    ]);
  });
});

describe("extractFormValues", () => {
  it("extracts all three values from state.values", () => {
    const stateValues = {
      issue_description: { description: { type: "plain_text_input", value: "  sink leaking  " } },
      issue_type: { type: { type: "static_select", selected_option: { value: "Plumbing" } } },
      issue_severity: { severity: { type: "static_select", selected_option: { value: "Medium" } } },
    };
    expect(extractFormValues(stateValues)).toEqual({
      description: "sink leaking",
      type: "Plumbing",
      severity: "Medium",
    });
  });

  it("reads values from form-key-scoped block_ids", () => {
    const stateValues = {
      "issue_description:100.1": { description: { type: "plain_text_input", value: "outlet cover" } },
      "issue_type:100.1": { type: { type: "static_select", selected_option: { value: "Electrical" } } },
      "issue_severity:100.1": { severity: { type: "static_select", selected_option: { value: "Minor" } } },
    };
    expect(extractFormValues(stateValues)).toEqual({
      description: "outlet cover",
      type: "Electrical",
      severity: "Minor",
    });
  });

  it("returns nulls for unset fields", () => {
    expect(extractFormValues({})).toEqual({ description: null, type: null, severity: null });
    expect(
      extractFormValues({
        issue_description: { description: { type: "plain_text_input", value: "   " } },
      })
    ).toEqual({ description: null, type: null, severity: null });
  });
});
