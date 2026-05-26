import { describe, it, expect } from "vitest";
import { extractSeverity, SEVERITY_OPTIONS } from "../../src/lib/severity.js";

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
