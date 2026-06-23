import { describe, it, expect } from "vitest";
import { parseTabName, isScheduleTab, selectTabForDate } from "../../src/lib/reservation-tabs.js";

describe("parseTabName", () => {
  it("parses a weekday tab", () =>
    expect(parseTabName("6/22-6/26 M-F")).toEqual({
      start: { month: 6, day: 22 }, end: { month: 6, day: 26 }, kind: "M-F",
    }));
  it("parses a weekend tab", () =>
    expect(parseTabName("6/27-6/28 S-Su")).toEqual({
      start: { month: 6, day: 27 }, end: { month: 6, day: 28 }, kind: "S-Su",
    }));
  it("rejects non-schedule tabs", () => {
    expect(parseTabName("BULLETIN")).toBeNull();
    expect(parseTabName("M-F Temp")).toBeNull();
    expect(parseTabName("Category/Legend")).toBeNull();
  });
});

describe("isScheduleTab", () => {
  it("accepts schedule tabs", () => expect(isScheduleTab("6/29-7/3 M-F")).toBe(true));
  it("rejects others", () => expect(isScheduleTab("Config")).toBe(false));
});

describe("selectTabForDate", () => {
  const tabs = ["BULLETIN", "6/22-6/26 M-F", "6/27-6/28 S-Su", "6/29-7/3 M-F"];
  it("selects the weekday tab containing the date", () =>
    expect(selectTabForDate(tabs, new Date("2026-06-24T12:00:00Z"))).toBe("6/22-6/26 M-F"));
  it("selects the weekend tab", () =>
    expect(selectTabForDate(tabs, new Date("2026-06-27T12:00:00Z"))).toBe("6/27-6/28 S-Su"));
  it("returns null when no tab covers the date", () =>
    expect(selectTabForDate(tabs, new Date("2026-08-01T12:00:00Z"))).toBeNull());
  it("selects a cross-year tab (Dec->Jan)", () =>
    expect(selectTabForDate(["12/29-1/2 M-F"], new Date("2026-12-31T12:00:00Z"))).toBe("12/29-1/2 M-F"));
  it("selects a cross-year tab from the January side", () =>
    expect(selectTabForDate(["12/29-1/2 M-F"], new Date("2027-01-01T12:00:00Z"))).toBe("12/29-1/2 M-F"));
});
