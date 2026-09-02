import { describe, it, expect, vi } from "vitest";
import { createIssueClassifierService } from "../../src/services/issueClassifier.js";
import { ISSUE_TYPES, SEVERITIES } from "../../src/lib/maintenance-form.js";

describe("IssueClassifierService", () => {
  it("returns what the model read out of the report", async () => {
    const llm = {
      classifyIssueReport: vi
        .fn()
        .mockResolvedValue({ type: "Elevator", severity: "Critical" }),
    };

    const result = await createIssueClassifierService(llm).classify(
      "someone is stuck in the elevator"
    );

    expect(result).toEqual({ type: "Elevator", severity: "Critical" });
  });

  it("hands the model the labels the form actually offers", async () => {
    const llm = {
      classifyIssueReport: vi.fn().mockResolvedValue({ type: null, severity: null }),
    };

    await createIssueClassifierService(llm).classify("something is wrong");

    expect(llm.classifyIssueReport).toHaveBeenCalledWith("something is wrong", {
      types: ISSUE_TYPES,
      severities: SEVERITIES,
    });
  });

  it("respects a null the model returned rather than second-guessing it", async () => {
    // The report is full of plumbing words, but the model declined to place it.
    // That judgement is the feature — it must not be overridden by keywords.
    const llm = {
      classifyIssueReport: vi.fn().mockResolvedValue({ type: null, severity: null }),
    };

    const result = await createIssueClassifierService(llm).classify(
      "the toilet is clogged and it is urgent"
    );

    expect(result).toEqual({ type: null, severity: null });
  });

  it("normalises a missing field to null", async () => {
    const llm = { classifyIssueReport: vi.fn().mockResolvedValue({ type: "HVAC" }) };
    expect(await createIssueClassifierService(llm).classify("no heat")).toEqual({
      type: "HVAC",
      severity: null,
    });
  });

  it("falls back to keywords when the model is unreachable", async () => {
    const llm = { classifyIssueReport: vi.fn().mockResolvedValue(null) };

    const result = await createIssueClassifierService(llm).classify(
      "the toilet on 2 is clogged, this is urgent"
    );

    expect(result).toEqual({ type: "Plumbing", severity: "Critical" });
  });

  it("falls back to keywords when the model call throws", async () => {
    const llm = {
      classifyIssueReport: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const result = await createIssueClassifierService(llm).classify("hallway light is out");

    expect(result).toEqual({ type: "Lighting", severity: null });
  });

  it("falls back to keywords when there is no model service at all", async () => {
    expect(await createIssueClassifierService(undefined).classify("roaches in the kitchen")).toEqual(
      { type: "Pest Control", severity: null }
    );
  });

  it("does not call the model for empty text", async () => {
    const llm = { classifyIssueReport: vi.fn() };
    expect(await createIssueClassifierService(llm).classify("  ")).toEqual({
      type: null,
      severity: null,
    });
    expect(llm.classifyIssueReport).not.toHaveBeenCalled();
  });
});
