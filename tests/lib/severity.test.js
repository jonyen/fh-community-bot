import { describe, it, expect } from "vitest";
import { extractSeverity, parseSeverityReply, SEVERITY_OPTIONS } from "../../src/lib/severity.js";

describe("extractSeverity", () => {
  it("returns null severity when none present", () => {
    expect(extractSeverity("printer jammed")).toEqual({
      description: "printer jammed",
      severity: null,
    });
  });

  it("extracts trailing severity after a dash", () => {
    expect(extractSeverity("printer jammed - critical")).toEqual({
      description: "printer jammed",
      severity: "Critical",
    });
  });

  it("extracts severity after a colon", () => {
    expect(extractSeverity("leaky faucet: medium")).toEqual({
      description: "leaky faucet",
      severity: "Medium",
    });
  });

  it("extracts 'minor severity' suffix", () => {
    expect(extractSeverity("door squeaks - minor severity")).toEqual({
      description: "door squeaks",
      severity: "Minor",
    });
  });

  it("is case-insensitive", () => {
    expect(extractSeverity("loud HVAC - MEDIUM")).toEqual({
      description: "loud HVAC",
      severity: "Medium",
    });
  });

  it("exposes SEVERITY_OPTIONS in lowercase", () => {
    expect(SEVERITY_OPTIONS).toEqual(["minor", "medium", "critical"]);
  });
});

describe("parseSeverityReply", () => {
  it("parses a bare severity word", () => {
    expect(parseSeverityReply("medium")).toBe("Medium");
  });

  it("is case-insensitive and capitalizes the result", () => {
    expect(parseSeverityReply("CRITICAL")).toBe("Critical");
    expect(parseSeverityReply("Minor")).toBe("Minor");
  });

  it("parses a severity keyword embedded in a longer sentence", () => {
    expect(parseSeverityReply("Medium but important to do it soon")).toBe("Medium");
  });

  it("parses a severity even with surrounding punctuation", () => {
    expect(parseSeverityReply("I'd say it's critical!")).toBe("Critical");
  });

  it("returns null when no severity word is present", () => {
    expect(parseSeverityReply("not sure")).toBeNull();
    expect(parseSeverityReply("")).toBeNull();
    expect(parseSeverityReply(undefined)).toBeNull();
  });

  it("returns null when more than one distinct severity is mentioned", () => {
    expect(parseSeverityReply("minor or maybe critical")).toBeNull();
  });

  it("does not match severity words embedded inside other words", () => {
    expect(parseSeverityReply("the mediumship was minorly off")).toBeNull();
  });
});
