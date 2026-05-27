import { describe, it, expect } from "vitest";
import {
  GENDER_TRIGGER_RE,
  GENDER_REFRESH_RE,
  matchesGenderEvent,
  referencedGenders,
  formatGenderReply,
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
  it("returns empty set on no match", () => {
    expect(referencedGenders("just chatter")).toEqual(new Set());
    expect(referencedGenders("")).toEqual(new Set());
    expect(referencedGenders(undefined)).toEqual(new Set());
  });

  it("returns {male} for bros aliases", () => {
    expect(referencedGenders("!bros")).toEqual(new Set(["male"]));
    expect(referencedGenders("@BROTHERS check this")).toEqual(new Set(["male"]));
  });

  it("returns {female} for sis aliases", () => {
    expect(referencedGenders("!sis")).toEqual(new Set(["female"]));
    expect(referencedGenders("hey @SISTERS")).toEqual(new Set(["female"]));
  });

  it("returns {male, female} when both appear", () => {
    expect(referencedGenders("@bros and @sis, hello")).toEqual(new Set(["male", "female"]));
    expect(referencedGenders("@sis @bros")).toEqual(new Set(["male", "female"]));
  });
});

describe("formatGenderReply", () => {
  const MEN = "<@U1> <@U2>";
  const WOMEN = "<@U9>";

  it("inserts mentions at trigger position - leading", () => {
    expect(formatGenderReply("@bros hello", { male: MEN })).toBe(`${MEN} hello`);
  });

  it("inserts mentions at trigger position - trailing", () => {
    expect(formatGenderReply("hello @bros", { male: MEN })).toBe(`hello ${MEN}`);
  });

  it("inserts mentions at trigger position - middle", () => {
    expect(formatGenderReply("hello @bros world", { male: MEN })).toBe(`hello ${MEN} world`);
  });

  it("substitutes each trigger inline when both genders referenced", () => {
    expect(formatGenderReply("@bros and @sis, hello", { male: MEN, female: WOMEN })).toBe(
      `${MEN} and ${WOMEN}, hello`
    );
  });

  it("handles bare trigger only", () => {
    expect(formatGenderReply("!bros", { male: MEN })).toBe(MEN);
  });

  it("returns concatenated mentions when text empty", () => {
    expect(formatGenderReply("", { male: MEN })).toBe(MEN);
    expect(formatGenderReply(undefined, { male: MEN, female: WOMEN })).toBe(`${MEN} ${WOMEN}`);
  });

  it("skips a trigger whose gender has no mentions", () => {
    expect(formatGenderReply("@bros and @sis, hello", { male: MEN, female: null })).toBe(
      `${MEN} and , hello`
    );
  });

  it("strips a stray refresh token from the body", () => {
    expect(formatGenderReply("@bros !refresh-genders hello", { male: MEN })).toBe(`${MEN} hello`);
  });

  it("collapses internal whitespace", () => {
    expect(formatGenderReply("   spaces  @bros   trailing   ", { male: MEN })).toBe(
      `spaces ${MEN} trailing`
    );
  });

  it("is case-insensitive on trigger words", () => {
    expect(formatGenderReply("@BROTHERS yo", { male: MEN })).toBe(`${MEN} yo`);
  });
});
