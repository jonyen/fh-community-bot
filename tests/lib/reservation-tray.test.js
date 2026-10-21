import { describe, it, expect } from "vitest";
import {
  MAX_LINES, MAX_DATES, MAX_REPEAT_DAYS, TRAY_TTL_S,
  emptyTray, newLine, expandDates, lineProblems, trayProblems, repeatText, lineSummary,
} from "../../src/lib/reservation-tray.js";

const L = (o = {}) => ({ id: "l1", item: "MPR", date: "2026-10-24", start: 840, end: 960, title: "MBS", appliances: {}, repeat: null, onlyDates: null, progress: {}, ...o });
const CTX = { today: "2026-10-20", nowMin: 600, catalog: [{ label: "MPR", category: "rooms", backend: "rooms" }] };

describe("reservation tray", () => {
  it("exports the limits", () => {
    expect([MAX_LINES, MAX_DATES, MAX_REPEAT_DAYS, TRAY_TTL_S]).toEqual([10, 60, 183, 86400]);
  });
  it("starts empty", () => {
    expect(emptyTray()).toEqual({ version: 1, lines: [], view: { q: "", c: "all", p: 0 }, editing: null, running: null });
  });
  it("expands a one-off line to its date, and a dateless one to nothing", () => {
    expect(expandDates(L())).toEqual(["2026-10-24"]);
    expect(expandDates(L({ date: null }))).toEqual([]);
  });
  it("expands a weekly Sat/Sun repeat through its until date", () => {
    expect(expandDates(L({ repeat: { days: [6, 0], until: "2026-11-01" } }))).toEqual(["2026-10-24", "2026-10-25", "2026-10-31", "2026-11-01"]);
  });
  it("keeps only onlyDates when set", () => {
    expect(expandDates(L({ repeat: { days: [6, 0], until: "2026-11-01" }, onlyDates: ["2026-10-31"] }))).toEqual(["2026-10-31"]);
  });
  it("passes a good line", () => {
    expect(lineProblems(L(), CTX)).toEqual([]);
  });
  it("names missing parts", () => {
    expect(lineProblems(L({ date: null, start: null, end: null, title: null }), CTX))
      .toEqual(["Pick a date.", "Pick a start and end time.", "Add what it's for."]);
  });
  it("names a backwards time, a past date and a past time today", () => {
    expect(lineProblems(L({ end: 840 }), CTX)).toContain("End must be after start.");
    expect(lineProblems(L({ date: "2026-10-19" }), CTX)).toContain("That date has passed.");
    expect(lineProblems(L({ date: "2026-10-20", start: 540, end: 660 }), CTX)).toContain("That time has already passed today.");
  });
  it("names an item the catalog dropped", () => {
    expect(lineProblems(L({ item: "Gym" }), CTX)).toContain("Gym can no longer be booked.");
  });
  it("names a repeat with no days, no end, a backwards until, or one over 6 months", () => {
    expect(lineProblems(L({ repeat: { days: [], until: "2026-11-01" } }), CTX)).toContain("Pick at least one day to repeat on.");
    expect(lineProblems(L({ repeat: { days: [6], until: null } }), CTX)).toContain("Pick when the repeat ends.");
    expect(lineProblems(L({ repeat: { days: [6], until: "2026-10-01" } }), CTX)).toContain("The repeat must end after its first date.");
    expect(lineProblems(L({ repeat: { days: [6], until: "2027-05-01" } }), CTX)).toContain("Repeats can run at most 6 months.");
  });
  it("prefixes tray problems with the item", () => {
    expect(trayProblems({ ...emptyTray(), lines: [L({ title: null })] }, CTX)).toEqual(["MPR: Add what it's for."]);
  });
  it("refuses a tray over 10 lines", () => {
    const lines = Array.from({ length: 11 }, (_, i) => L({ id: `l${i}` }));
    expect(trayProblems({ ...emptyTray(), lines }, CTX)).toContain("Your tray has more than 10 lines.");
  });
  it("refuses a tray over 60 dates and names the count", () => {
    const big = { ...emptyTray(), lines: [L({ repeat: { days: [0, 1, 2, 3, 4, 5, 6], until: "2027-01-01" } })] };
    expect(trayProblems(big, CTX)).toContain("That's 70 dates; Reserve all can do at most 60 at once.");
  });
  it("newLine copies the previous line's when and what-for, not its appliances", () => {
    const prev = L({ appliances: { island: true }, progress: { "2026-10-24": "done" } });
    const l = newLine("Kitchen", prev, () => "l2");
    expect(l).toMatchObject({ id: "l2", item: "Kitchen", date: "2026-10-24", start: 840, end: 960, title: "MBS", appliances: {}, progress: {}, onlyDates: null });
  });
  it("newLine starts blank with no previous line and makes an 8-hex id", () => {
    const l = newLine("MPR", null);
    expect(l).toMatchObject({ item: "MPR", date: null, start: null, end: null, title: null, repeat: null });
    expect(l.id).toMatch(/^[0-9a-f]{8}$/);
  });
  it("describes a repeat", () => {
    expect(repeatText({ days: [6, 0], until: "2026-12-20" })).toBe("every Sat, Sun until Sun 12/20");
  });
  it("summarises lines", () => {
    expect(lineSummary(L())).toBe("MPR · Sat 10/24 · 2:00–4:00 PM · MBS");
    expect(lineSummary(L({ date: null, start: null, title: null }))).toBe("MPR · _day?_ · _time?_ · _what for?_");
    expect(lineSummary(L({ repeat: { days: [6, 0], until: "2026-11-01" } }))).toBe("MPR · Sat 10/24 · 2:00–4:00 PM · MBS · every Sat, Sun until Sun 11/1 · 4 dates");
  });
});
