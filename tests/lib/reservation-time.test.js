// tests/lib/reservation-time.test.js
import { describe, it, expect } from "vitest";
import {
  parseSheetDate, formatSheetDate, parseSheetTime, hhmmToMin, fmtTime, fmtRange,
  overlaps, nyOffset, nyDateTime, nyLocal, nyParts, nyToday, addDaysIso, weekOf, fmtDay, weekdayName,
  digestPeriod, periodCovering,
} from "../../src/lib/reservation-time.js";

describe("parseSheetDate", () => {
  it("reads room-sheet dates with a 2-digit year", () => {
    expect(parseSheetDate("Tue, 6/23/26", "2026-10-14")).toBe("2026-06-23");
  });
  it("reads 4-digit years and bare dates", () => {
    expect(parseSheetDate("6/23/2026", "2026-10-14")).toBe("2026-06-23");
  });
  it("reads kitchen dates without a year in the reference year", () => {
    expect(parseSheetDate("Thu, 09/03", "2026-10-14")).toBe("2026-09-03");
  });
  it("rolls a yearless date into next year when it would be over 180 days past", () => {
    expect(parseSheetDate("Thu, 01/07", "2026-12-20")).toBe("2027-01-07");
  });
  it("returns null for non-dates", () => {
    expect(parseSheetDate("SAMPLE", "2026-10-14")).toBeNull();
    expect(parseSheetDate("", "2026-10-14")).toBeNull();
    expect(parseSheetDate("13/40/26", "2026-10-14")).toBeNull();
  });
});

describe("formatSheetDate", () => {
  it("writes the room-sheet format", () => {
    expect(formatSheetDate("2026-06-23")).toBe("Tue, 6/23/26");
  });
});

describe("parseSheetTime", () => {
  it("reads both sheet formats", () => {
    expect(parseSheetTime("6:00:00 PM")).toBe(18 * 60);
    expect(parseSheetTime("9:00 PM")).toBe(21 * 60);
    expect(parseSheetTime("12:00 AM")).toBe(0);
    expect(parseSheetTime("12:30 PM")).toBe(12 * 60 + 30);
    expect(parseSheetTime("11:59 PM")).toBe(23 * 60 + 59);
    expect(parseSheetTime("18:30")).toBe(18 * 60 + 30);
  });
  it("returns null for blanks and junk", () => {
    expect(parseSheetTime("")).toBeNull();
    expect(parseSheetTime(undefined)).toBeNull();
    expect(parseSheetTime("TBD")).toBeNull();
  });
});

describe("formatting", () => {
  it("hhmmToMin", () => {
    expect(hhmmToMin("14:30")).toBe(870);
    expect(hhmmToMin("25:00")).toBeNull();
    expect(hhmmToMin(null)).toBeNull();
  });
  it("fmtTime", () => {
    expect(fmtTime(0)).toBe("12:00 AM");
    expect(fmtTime(870)).toBe("2:30 PM");
    expect(fmtTime(12 * 60)).toBe("12:00 PM");
  });
  it("fmtRange", () => {
    expect(fmtRange(840, 960)).toBe("2:00–4:00 PM");
    expect(fmtRange(600, 840)).toBe("10:00 AM–2:00 PM");
    expect(fmtRange(null, null)).toBe("All day");
    // An end at midnight (1440) is the end of the day, not noon.
    expect(fmtRange(1020, 1440)).toBe("5:00 PM–12:00 AM");
    expect(fmtTime(1440)).toBe("12:00 AM");
  });
  it("fmtDay and weekdayName", () => {
    expect(fmtDay("2026-10-17")).toBe("Sat 10/17");
    expect(weekdayName("2026-10-17")).toBe("Saturday");
  });
});

describe("overlaps", () => {
  it("is strict at the edges", () => {
    expect(overlaps(840, 960, 960, 1020)).toBe(false);
    expect(overlaps(840, 960, 900, 1020)).toBe(true);
  });
  it("treats null times as all day", () => {
    expect(overlaps(null, null, 900, 1020)).toBe(true);
  });
});

describe("NY time zone", () => {
  it("uses EDT before and EST after the November change", () => {
    expect(nyOffset("2026-10-31")).toBe("-04:00");
    expect(nyOffset("2026-11-01")).toBe("-05:00");
    expect(nyDateTime("2026-11-02", 840)).toBe("2026-11-02T14:00:00-05:00");
    expect(nyDateTime("2026-10-17", 840)).toBe("2026-10-17T14:00:00-04:00");
  });
  it("nyLocal has no offset", () => {
    expect(nyLocal("2026-10-17", 840)).toBe("2026-10-17T14:00:00");
  });
  it("nyParts converts an RFC3339 instant to NY date and minutes", () => {
    expect(nyParts("2026-10-17T18:00:00Z")).toEqual({ date: "2026-10-17", min: 14 * 60 });
    expect(nyParts("2026-10-18T02:30:00Z")).toEqual({ date: "2026-10-17", min: 22 * 60 + 30 });
  });
  it("nyToday uses the NY calendar day", () => {
    expect(nyToday(new Date("2026-10-15T03:00:00Z"))).toBe("2026-10-14");
  });
  it("addDaysIso", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
  });
  it("weekOf gives Monday to Sunday", () => {
    expect(weekOf(new Date("2026-10-12T12:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(weekOf(new Date("2026-10-18T12:00:00Z"))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });
});

describe("digest periods", () => {
  it("digestPeriod gives Mon–Thu and Fri–Sun of the current week", () => {
    const mon = new Date("2026-10-19T12:00:00Z");
    expect(digestPeriod("weekday", mon)).toEqual({ kind: "weekday", from: "2026-10-19", to: "2026-10-22" });
    expect(digestPeriod("weekend", new Date("2026-10-23T12:00:00Z"))).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
  });
  it("periodCovering puts Friday in the weekend and Thursday in the weekday", () => {
    expect(periodCovering("2026-10-22")).toEqual({ kind: "weekday", from: "2026-10-19", to: "2026-10-22" });
    expect(periodCovering("2026-10-23")).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
    expect(periodCovering("2026-10-25")).toEqual({ kind: "weekend", from: "2026-10-23", to: "2026-10-25" });
  });
});
