import { describe, it, expect } from "vitest";
import {
  classifyIssue,
  classifyIssueType,
  classifySeverity,
} from "../../src/lib/issue-classify.js";
import { ISSUE_TYPES, SEVERITIES } from "../../src/lib/maintenance-form.js";

describe("classifyIssueType", () => {
  const cases = [
    ["the hallway light is out again", "Lighting"],
    ["two bulbs burned out in the stairwell", "Lighting"],
    ["elevator is not stopping on the 3rd floor", "Elevator"],
    ["roaches in the kitchen cabinets", "Pest Control"],
    ["we have mice in the storage closet", "Pest Control"],
    ["outlet in the lounge stopped working", "Electrical"],
    ["breaker keeps tripping in the office", "Electrical"],
    ["toilet in the 2nd floor bathroom is clogged", "Plumbing"],
    ["faucet in the kitchen is dripping", "Plumbing"],
    ["thermostat in the MPR is broken", "HVAC"],
    ["furnace is not turning on", "HVAC"],
    ["trash cans by the dumpster are overflowing with litter", "Janitorial"],
    ["graffiti on the wall by the entrance", "Janitorial"],
  ];

  it.each(cases)("reads %j as %s", (text, expected) => {
    expect(classifyIssueType(text)).toBe(expected);
  });

  it("only ever returns a type the form offers", () => {
    for (const [text] of cases) {
      expect(ISSUE_TYPES).toContain(classifyIssueType(text));
    }
  });

  it("scores the longest keyword only, so a water heater is plumbing not HVAC", () => {
    expect(classifyIssueType("the water heater is making a loud noise")).toBe("Plumbing");
  });

  it("prefers the category with more supporting words", () => {
    expect(classifyIssueType("toilet is clogged and the light above it is out")).toBe(
      "Plumbing"
    );
  });

  it.each([
    ["water is leaking out of the AC unit", "plumbing and HVAC pull evenly"],
    ["lobby printer is jammed", "no category matches"],
    ["hello, is anyone around?", "not a report at all"],
    ["", "empty text"],
    [null, "no text"],
  ])("leaves %j unclassified (%s)", (text) => {
    expect(classifyIssueType(text)).toBeNull();
  });

  it("never guesses Other — that judgement is the reporter's", () => {
    expect(classifyIssueType("other")).toBeNull();
    expect(classifyIssueType("something else is wrong, not sure what")).toBeNull();
  });
});

describe("classifySeverity", () => {
  it.each([
    ["this is an emergency, water everywhere", "Critical"],
    ["sewage is backing up in the basement", "Critical"],
    ["no heat in the whole building", "Critical"],
    ["please fix urgently", "Critical"],
    ["minor scuff on the paint", "Minor"],
    ["small crack in the tile, no rush", "Minor"],
    ["whenever someone gets a chance", "Minor"],
  ])("reads %j as %s", (text, expected) => {
    expect(classifySeverity(text)).toBe(expected);
    expect(SEVERITIES).toContain(expected);
  });

  it.each([
    ["the light in the hallway is out", "no urgency signal either way"],
    ["minor flooding in the basement", "minor and critical pull evenly"],
    ["", "empty text"],
  ])("leaves %j unclassified (%s)", (text) => {
    expect(classifySeverity(text)).toBeNull();
  });
});

describe("classifyIssue", () => {
  it("returns both fields together", () => {
    expect(classifyIssue("sparking outlet in the lounge, this is urgent")).toEqual({
      type: "Electrical",
      severity: "Critical",
    });
  });

  it("returns a field at a time — one clear, one not", () => {
    expect(classifyIssue("minor squeak somewhere in the building")).toEqual({
      type: null,
      severity: "Minor",
    });
    expect(classifyIssue("hallway light is out")).toEqual({
      type: "Lighting",
      severity: null,
    });
  });

  it("is case- and punctuation-insensitive", () => {
    expect(classifyIssue("The TOILET is clogged!!! URGENT!!")).toEqual({
      type: "Plumbing",
      severity: "Critical",
    });
  });
});
