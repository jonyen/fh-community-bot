import { describe, it, expect } from "vitest";
import {
  GENDER_TRIGGER_RE,
  GENDER_REFRESH_RE,
  matchesGenderEvent,
  resolveTarget,
  stripTriggers,
} from "../../src/lib/gender-triggers.js";

describe("GENDER_TRIGGER_RE", () => {
  it.each([
    ["!bros", true],
    ["!brothers", true],
    ["@bros", true],
    ["@brothers", true],
    ["!sis", true],
    ["!sisters", true],
    ["@sis", true],
    ["@sisters", true],
    ["  !bros at start of trim", true],
    ["hey !bros stand up", true],
    ["hey @SISTERS", true],
    ["bros without prefix", false],
    ["!brosx", false],
    ["!sissy", false],
    ["foo!bros mid-word", false],
    ["", false],
  ])("matches %p -> %p", (text, expected) => {
    expect(GENDER_TRIGGER_RE.test(text)).toBe(expected);
  });
});

describe("GENDER_REFRESH_RE", () => {
  it.each([
    ["!refresh-genders", true],
    ["@refresh-genders", true],
    [" @REFRESH-genders ", true],
    ["refresh-genders no prefix", false],
    ["!refresh-gendersX", false],
    ["", false],
  ])("matches %p -> %p", (text, expected) => {
    expect(GENDER_REFRESH_RE.test(text)).toBe(expected);
  });
});

describe("matchesGenderEvent", () => {
  it("is true if either trigger or refresh matches", () => {
    expect(matchesGenderEvent("hello !bros")).toBe(true);
    expect(matchesGenderEvent("!refresh-genders")).toBe(true);
    expect(matchesGenderEvent("just chatter")).toBe(false);
    expect(matchesGenderEvent("")).toBe(false);
    expect(matchesGenderEvent(undefined)).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("returns 'male' for bros/brothers", () => {
    expect(resolveTarget("!bros")).toBe("male");
    expect(resolveTarget("@BROTHERS check this")).toBe("male");
  });

  it("returns 'female' for sis/sisters", () => {
    expect(resolveTarget("!sis")).toBe("female");
    expect(resolveTarget("hey @SISTERS")).toBe("female");
  });

  it("prefers 'male' when both appear (matches Python precedence)", () => {
    expect(resolveTarget("!bros !sis")).toBe("male");
    expect(resolveTarget("!sis !bros")).toBe("male");
  });

  it("returns null on no match", () => {
    expect(resolveTarget("bros")).toBe(null);
    expect(resolveTarget("")).toBe(null);
    expect(resolveTarget(undefined)).toBe(null);
  });
});

describe("stripTriggers", () => {
  it.each([
    ["@bros hello", "hello"],
    ["!bros", ""],
    ["hey @bros watch this", "hey watch this"],
    ["@bros @sis foo", "foo"],
    ["@BROTHERS check this out", "check this out"],
    ["before @bros middle @sisters after", "before middle after"],
    ["!refresh-genders please", "please"],
    ["just chatter, no trigger", "just chatter, no trigger"],
    ["   leading spaces @bros   ", "leading spaces"],
    ["", ""],
    [undefined, ""],
  ])("strips %p -> %p", (text, expected) => {
    expect(stripTriggers(text)).toBe(expected);
  });
});
