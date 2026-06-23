import { describe, it, expect } from "vitest";
import {
  parseTimeToMinutes,
  formatMinutes,
  parseMonthDay,
  inferYear,
  isAllDay,
} from "../../src/lib/reservation-time.js";

describe("parseTimeToMinutes", () => {
  it("parses PM times", () => expect(parseTimeToMinutes("9:00 PM")).toBe(21 * 60));
  it("parses AM times", () => expect(parseTimeToMinutes("12:30 AM")).toBe(30));
  it("parses noon", () => expect(parseTimeToMinutes("12:00 PM")).toBe(12 * 60));
  it("tolerates surrounding whitespace/newlines", () =>
    expect(parseTimeToMinutes(" 5:00 PM\n")).toBe(17 * 60));
  it("returns null for blank", () => expect(parseTimeToMinutes("")).toBeNull());
  it("returns null for garbage", () => expect(parseTimeToMinutes("c")).toBeNull());
});

describe("formatMinutes", () => {
  it("formats PM", () => expect(formatMinutes(21 * 60)).toBe("9:00 PM"));
  it("formats midnight", () => expect(formatMinutes(0)).toBe("12:00 AM"));
});

describe("parseMonthDay", () => {
  it("parses date+weekday", () => expect(parseMonthDay("6/22 Mon")).toEqual({ month: 6, day: 22 }));
  it("parses without weekday", () => expect(parseMonthDay("12/3")).toEqual({ month: 12, day: 3 }));
  it("returns null for blank", () => expect(parseMonthDay("")).toBeNull());
});

describe("inferYear", () => {
  it("uses same year when close", () =>
    expect(inferYear(6, 22, new Date("2026-06-20T00:00:00Z"))).toBe(2026));
  it("rolls to next year across Dec->Jan boundary", () =>
    expect(inferYear(1, 2, new Date("2026-12-30T00:00:00Z"))).toBe(2027));
  it("rolls to previous year across Jan->Dec boundary", () =>
    expect(inferYear(12, 30, new Date("2027-01-02T00:00:00Z"))).toBe(2026));
});

describe("isAllDay", () => {
  it("detects all-day", () => expect(isAllDay(0, 23 * 60 + 59)).toBe(true));
  it("rejects partial", () => expect(isAllDay(17 * 60, 19 * 60)).toBe(false));
});
