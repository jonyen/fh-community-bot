import { describe, it, expect } from "vitest";
import { extractSeverity, parseSeverityReply, SEVERITY_OPTIONS } from "../../src/lib/severity.js";

describe("extractSeverity", () => {
  it("returns description and null severity when no severity present", () => {
    const result = extractSeverity("The printer is broken");
    expect(result).toEqual({ description: "The printer is broken", severity: null });
  });

  it("extracts critical severity with dash separator", () => {
    const result = extractSeverity("Water leak in ceiling - critical");
    expect(result).toEqual({ description: "Water leak in ceiling", severity: "Critical" });
  });

  it("extracts medium severity with comma", () => {
    const result = extractSeverity("Broken chair, medium");
    expect(result).toEqual({ description: "Broken chair", severity: "Medium" });
  });

  it("extracts severity with 'severity:' prefix", () => {
    const result = extractSeverity("Door handle loose severity: minor");
    expect(result).toEqual({ description: "Door handle loose", severity: "Minor" });
  });

  it("is case insensitive", () => {
    const result = extractSeverity("Broken AC - CRITICAL");
    expect(result).toEqual({ description: "Broken AC", severity: "Critical" });
  });

  it("returns full text when severity word is in the middle", () => {
    const result = extractSeverity("The critical system is down");
    expect(result).toEqual({ description: "The critical system is down", severity: null });
  });

  it("handles 'priority' keyword", () => {
    const result = extractSeverity("Leaky faucet - high priority");
    expect(result).toEqual({ description: "Leaky faucet", severity: null });
  });

  it("extracts severity with priority keyword", () => {
    const result = extractSeverity("Broken window - critical priority");
    expect(result).toEqual({ description: "Broken window", severity: "Critical" });
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

  it("only knows the three documented options", () => {
    expect(SEVERITY_OPTIONS).toEqual(["minor", "medium", "critical"]);
  });
});
