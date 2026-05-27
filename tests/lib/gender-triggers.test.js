import { describe, it, expect } from "vitest";
import {
  GENDER_TRIGGER_RE,
  GENDER_REFRESH_RE,
  matchesGenderEvent,
  referencedGenders,
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
  it("is true only when a gender ping trigger matches", () => {
    expect(matchesGenderEvent("hello !bros")).toBe(true);
    expect(matchesGenderEvent("!refresh-genders")).toBe(false);
    expect(matchesGenderEvent("just chatter")).toBe(false);
    expect(matchesGenderEvent("")).toBe(false);
    expect(matchesGenderEvent(undefined)).toBe(false);
  });
});

describe("referencedGenders", () => {
  it("returns empty array on no match", () => {
    expect(referencedGenders("just chatter")).toEqual([]);
    expect(referencedGenders("")).toEqual([]);
    expect(referencedGenders(undefined)).toEqual([]);
  });

  it("returns ['male'] for bros aliases", () => {
    expect(referencedGenders("!bros")).toEqual(["male"]);
    expect(referencedGenders("@BROTHERS check this")).toEqual(["male"]);
  });

  it("returns ['female'] for sis aliases", () => {
    expect(referencedGenders("!sis")).toEqual(["female"]);
    expect(referencedGenders("hey @SISTERS")).toEqual(["female"]);
  });

  it("returns both genders in encounter order, deduped", () => {
    expect(referencedGenders("@bros and @sis, hello")).toEqual(["male", "female"]);
    expect(referencedGenders("@sis @bros")).toEqual(["female", "male"]);
    expect(referencedGenders("@bros @bros @sis")).toEqual(["male", "female"]);
  });
});
