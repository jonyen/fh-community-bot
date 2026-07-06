import { describe, it, expect } from "vitest";
import {
  buildMaintenanceFormBlocks,
  extractFormValues,
  SUBMIT_ACTION_ID,
  ISSUE_TYPES,
  SEVERITIES,
} from "../../src/lib/maintenance-form.js";

describe("buildMaintenanceFormBlocks", () => {
  it("builds description, type, severity inputs and a submit button", () => {
    const blocks = buildMaintenanceFormBlocks("sink leaking");

    const description = blocks.find((b) => b.block_id === "issue_description");
    expect(description.type).toBe("input");
    expect(description.element.type).toBe("plain_text_input");
    expect(description.element.action_id).toBe("description");
    expect(description.element.multiline).toBe(true);
    expect(description.element.initial_value).toBe("sink leaking");

    const type = blocks.find((b) => b.block_id === "issue_type");
    expect(type.element.type).toBe("static_select");
    expect(type.element.action_id).toBe("type");
    expect(type.element.options.map((o) => o.value)).toEqual(ISSUE_TYPES);

    const severity = blocks.find((b) => b.block_id === "issue_severity");
    expect(severity.element.type).toBe("static_select");
    expect(severity.element.action_id).toBe("severity");
    expect(severity.element.options.map((o) => o.value)).toEqual(SEVERITIES);

    const actions = blocks.find((b) => b.block_id === "submit_actions");
    expect(actions.type).toBe("actions");
    expect(actions.elements[0].action_id).toBe(SUBMIT_ACTION_ID);
  });

  it("omits initial_value when no description prefill", () => {
    const blocks = buildMaintenanceFormBlocks("");
    const description = blocks.find((b) => b.block_id === "issue_description");
    expect(description.element).not.toHaveProperty("initial_value");
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

  it("returns nulls for unset fields", () => {
    expect(extractFormValues({})).toEqual({ description: null, type: null, severity: null });
    expect(
      extractFormValues({
        issue_description: { description: { type: "plain_text_input", value: "   " } },
      })
    ).toEqual({ description: null, type: null, severity: null });
  });
});
