// tests/services/reservations/kitchen.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKitchenAdapter, APPLIANCES } from "../../../src/services/reservations/kitchen.js";

const F = ["FALSE", "FALSE", "FALSE", "--", "--", "FALSE", "FALSE", "FALSE"];
const SHEET = [
  [],
  ["No more than 3 ministry groups at same cooking time frame please."],
  ["Date", "Name", "Phone Number ", "Start Time", "End Time", "Kitchen Island (3)"],
  ["SAMPLE", "Arie Chen", "530-902-3809", "5:00 PM", "7:00 PM", "TRUE"],
  ["To add MORE dates: ..."],
  [],
  ["Sat, 10/17", "RPG", "111", "5:00 PM", "7:00 PM", ...F],   // row 7
  ["Sat, 10/17", "AYM", "222", "6:00 PM", "8:00 PM", ...F],   // row 8
  ["Sat, 10/17", "", "", "", "", ...F],                        // row 9
  ["Sun, 10/18", "A", "1", "5:00 PM", "7:00 PM", ...F],       // row 10
  ["Sun, 10/18", "B", "2", "5:00 PM", "7:00 PM", ...F],       // row 11
  ["Sun, 10/18", "C", "3", "6:00 PM", "9:00 PM", ...F],       // row 12
  ["Mon, 10/19", "X", "9", "9:00 AM", "10:00 AM", ...F],      // row 13
  ["Mon, 10/19", "Y", "8", "11:00 AM", "12:00 PM", ...F],     // row 14
  ["Mon, 10/19", "Z", "7", "1:00 PM", "2:00 PM", ...F],       // row 15
];

function makeSheets(values = SHEET) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values } }),
        batchUpdate: vi.fn().mockResolvedValue({}),
        clear: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("kitchen adapter", () => {
  let sheets;
  let adapter;
  beforeEach(() => {
    sheets = makeSheets();
    adapter = createKitchenAdapter({
      sheetsClient: sheets, spreadsheetId: "K1", tab: "FH-Kitchen-RSVP", link: "https://kitchen",
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("lists filled rows after the header, skipping SAMPLE rows", async () => {
    const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17" });
    expect(reservations).toEqual([
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1020, end: 1140, title: "RPG", holder: "RPG (111)", holderName: "RPG", phone: "111", holderUserId: null, holderEmail: null,
        ref: { backend: "kitchen", row: 7, date: "2026-10-17", name: "RPG", start: 1020, end: 1140 } },
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1080, end: 1200, title: "AYM", holder: "AYM (222)", holderName: "AYM", phone: "222", holderUserId: null, holderEmail: null,
        ref: { backend: "kitchen", row: 8, date: "2026-10-17", name: "AYM", start: 1080, end: 1200 } },
    ]);
  });

  it("has no conflict while fewer than 3 groups overlap", async () => {
    expect(await adapter.findConflicts({ date: "2026-10-17", start: 1080, end: 1140, items: [] })).toEqual([]);
  });

  it("conflicts when 3 groups already overlap, returning all three", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-18", start: 1080, end: 1110, items: [] });
    expect(hits.map((h) => h.title)).toEqual(["A", "B", "C"]);
  });

  it("checks many dates with one read, flagging a date the sheet has no rows for", async () => {
    const res = await adapter.checkDates({
      dates: ["2026-10-17", "2026-10-18", "2026-10-30"], start: 1080, end: 1140, items: [],
    });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    expect(res["2026-10-17"]).toEqual({ conflicts: [], unavailable: null });
    expect(res["2026-10-18"].conflicts.map((c) => c.title)).toEqual(["A", "B", "C"]);
    expect(res["2026-10-18"].unavailable).toBeNull();
    expect(res["2026-10-30"]).toEqual({ conflicts: [], unavailable: "The kitchen sheet is not open yet for that date." });
  });

  it("fills the first empty row for the date, only touching requested appliances", async () => {
    const res = await adapter.book({
      date: "2026-10-17", start: 1020, end: 1080, requesterName: "Jina Kim", phone: "555-0100",
      appliances: { airFryer: true, largeRiceCooker: 2 },
    });
    expect(res).toEqual({
      status: "booked", link: "https://kitchen",
      ref: { backend: "kitchen", row: 9, date: "2026-10-17", name: "Jina Kim", start: 1020, end: 1080 },
    });
    expect(sheets.spreadsheets.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "K1",
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "'FH-Kitchen-RSVP'!B9:E9", values: [["Jina Kim", "555-0100", "5:00 PM", "6:00 PM"]] },
          { range: "'FH-Kitchen-RSVP'!L9", values: [["TRUE"]] },
          { range: "'FH-Kitchen-RSVP'!N9", values: [[2]] },
        ],
      },
    });
  });

  it("is unavailable when every row for the date is filled", async () => {
    const res = await adapter.book({ date: "2026-10-19", start: 1080, end: 1140, requesterName: "J", phone: "", appliances: {} });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/all 3 kitchen rows/i);
    expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
  });

  it("is unavailable when the date has no rows yet", async () => {
    const res = await adapter.book({ date: "2026-12-01", start: 1080, end: 1140, requesterName: "J", phone: "", appliances: {} });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/not open yet/i);
  });

  it("names the appliance keys the parser may use", () => {
    expect(APPLIANCES.map((a) => a.key)).toEqual([
      "island", "whiteCounter", "brownCounter", "freezer", "fridge", "toasterOven",
      "airFryer", "microwave", "largeRiceCooker", "smallRiceCooker", "instapot",
    ]);
  });

  it("keeps a +1 phone and odd names as text (review fix)", async () => {
    await adapter.book({ date: "2026-10-17", start: 1020, end: 1080, requesterName: "@jina", phone: "+1 703-555-1234", appliances: {} });
    const data = sheets.spreadsheets.values.batchUpdate.mock.calls[0][0].requestBody.data;
    expect(data[0].values[0].slice(0, 2)).toEqual(["'@jina", "'+1 703-555-1234"]);
  });

  it("writes with the member's Sheets client but finds the row with the bot's", async () => {
    const member = { spreadsheets: { values: { batchUpdate: vi.fn().mockResolvedValue({}) } } };
    await adapter.book(
      { date: "2026-10-17", start: 1020, end: 1080, requesterName: "J", phone: "", appliances: {} },
      { clients: { sheetsClient: member } }
    );
    expect(sheets.spreadsheets.values.get).toHaveBeenCalled();
    expect(member.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
  });

  describe("bookMany", () => {
    const mk = (date, name, extra = {}) => ({ date, start: 1020, end: 1080, requesterName: name, phone: "", appliances: {}, ...extra });
    // Sat 10/17 with rows 7 (RPG) and 8, 9 free.
    const TWO_FREE = [...SHEET.slice(0, 7), ["Sat, 10/17", "", "", "", "", ...F], ["Sat, 10/17", "", "", "", "", ...F], ...SHEET.slice(9)];

    it("gives two groups on one day two rows in a single batchUpdate", async () => {
      sheets = makeSheets(TWO_FREE);
      adapter = createKitchenAdapter({
        sheetsClient: sheets, spreadsheetId: "K1", tab: "FH-Kitchen-RSVP", link: "https://kitchen",
        now: () => new Date("2026-10-14T12:00:00Z"),
      });
      const res = await adapter.bookMany([
        mk("2026-10-17", "  Jina ", { phone: "555", appliances: { island: true, freezer: 2 } }),
        mk("2026-10-17", "Sam"),
      ]);
      expect(res.map((r) => r.status)).toEqual(["booked", "booked"]);
      expect(res.map((r) => r.ref.row)).toEqual([8, 9]);
      expect(res[0].ref).toEqual({ backend: "kitchen", row: 8, date: "2026-10-17", name: "Jina", start: 1020, end: 1080 });
      expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(sheets.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
      const { data, valueInputOption } = sheets.spreadsheets.values.batchUpdate.mock.calls[0][0].requestBody;
      expect(valueInputOption).toBe("USER_ENTERED");
      expect(data).toEqual([
        { range: "'FH-Kitchen-RSVP'!B8:E8", values: [["  Jina ", "555", "5:00 PM", "6:00 PM"]] },
        { range: "'FH-Kitchen-RSVP'!F8", values: [["TRUE"]] },
        { range: "'FH-Kitchen-RSVP'!I8", values: [[2]] },
        { range: "'FH-Kitchen-RSVP'!B9:E9", values: [["Sam", "", "5:00 PM", "6:00 PM"]] },
      ]);
    });

    it("reports a date with no rows as not open yet and a full day as taken, booking the rest", async () => {
      const res = await adapter.bookMany([mk("2026-12-01", "A"), mk("2026-10-18", "B"), mk("2026-10-17", "C"), mk("2026-10-17", "D")]);
      expect(res[0]).toEqual({ status: "unavailable", reason: "The kitchen sheet is not open yet for that date.", link: "https://kitchen" });
      expect(res[1]).toEqual({ status: "unavailable", reason: "All 3 kitchen rows for that day are taken.", link: "https://kitchen" });
      expect(res[2].status).toBe("booked");
      expect(res[2].ref.row).toBe(9);
      expect(res[3]).toEqual({ status: "unavailable", reason: "All 3 kitchen rows for that day are taken.", link: "https://kitchen" });
      expect(sheets.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    });

    it("makes every booked result an error when the write fails", async () => {
      sheets.spreadsheets.values.batchUpdate.mockRejectedValue(new Error("quota"));
      const res = await adapter.bookMany([mk("2026-10-17", "C"), mk("2026-12-01", "A")]);
      expect(res[0]).toEqual({ status: "error", error: expect.objectContaining({ message: "quota" }) });
      expect(res[1].status).toBe("unavailable");
    });

    it("turns a failed read into errors, and writes nothing when no row is free", async () => {
      sheets.spreadsheets.values.get.mockRejectedValue(new Error("down"));
      expect(await adapter.bookMany([mk("2026-10-17", "C")])).toEqual([{ status: "error", error: expect.objectContaining({ message: "down" }) }]);
      expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
    });

    it("turns a malformed booking into an error and still books the others", async () => {
      const res = await adapter.bookMany([mk("2026-10-17", undefined), mk("2026-10-17", "C")]);
      expect(res[0].status).toBe("error");
      expect(res[0].error).toBeInstanceOf(Error);
      expect(res[1].status).toBe("booked");
      expect(res[1].ref.row).toBe(9);
      const { data } = sheets.spreadsheets.values.batchUpdate.mock.calls[0][0].requestBody;
      expect(data.map((d) => d.range)).toEqual(["'FH-Kitchen-RSVP'!B9:E9"]);
    });

    it("writes with the member's Sheets client when given", async () => {
      const member = { spreadsheets: { values: { batchUpdate: vi.fn().mockResolvedValue({}) } } };
      await adapter.bookMany([mk("2026-10-17", "C")], { clients: { sheetsClient: member } });
      expect(member.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
      expect(sheets.spreadsheets.values.batchUpdate).not.toHaveBeenCalled();
    });
  });

  it("book's ref equals what a later read of that row lists", async () => {
    const res = await adapter.book({ date: "2026-10-17", start: 1020, end: 1080, requesterName: "  Jina Kim ", phone: "", appliances: {} });
    const rows = SHEET.map((r) => [...r]);
    rows[8] = ["Sat, 10/17", "Jina Kim", "", "5:00 PM", "6:00 PM", ...F];
    adapter = createKitchenAdapter({
      sheetsClient: makeSheets(rows), spreadsheetId: "K1", tab: "FH-Kitchen-RSVP", link: "https://kitchen",
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
    const { reservations } = await adapter.listReservations({ from: "2026-10-17", to: "2026-10-17" });
    expect(reservations.find((r) => r.ref.row === 9).ref).toEqual(res.ref);
  });

  describe("cancel", () => {
    const ref = { backend: "kitchen", row: 7, date: "2026-10-17", name: "RPG", start: 1020, end: 1140 };

    it("clears B:P of the row", async () => {
      const res = await adapter.cancel(ref);
      expect(sheets.spreadsheets.values.clear).toHaveBeenCalledWith({ spreadsheetId: "K1", range: "'FH-Kitchen-RSVP'!B7:P7" });
      expect(res).toEqual({ status: "cancelled", link: "https://kitchen" });
    });

    it("returns already when the row's name is empty", async () => {
      const res = await adapter.cancel({ ...ref, row: 9 });
      expect(res).toEqual({ status: "already", link: "https://kitchen" });
      expect(sheets.spreadsheets.values.clear).not.toHaveBeenCalled();
    });

    it("returns changed when the name or times differ, and clears nothing", async () => {
      for (const patch of [{ name: "Other" }, { start: 1000 }, { end: 1200 }, { date: "2026-10-18" }]) {
        const res = await adapter.cancel({ ...ref, ...patch });
        expect(res).toEqual({ status: "changed", link: "https://kitchen" });
      }
      expect(sheets.spreadsheets.values.clear).not.toHaveBeenCalled();
    });

    it("returns changed when the row is gone", async () => {
      const res = await adapter.cancel({ ...ref, row: 99 });
      expect(res.status).toBe("changed");
      expect(sheets.spreadsheets.values.clear).not.toHaveBeenCalled();
    });

    it("ignores appliance columns when matching", async () => {
      const rows = SHEET.map((r) => [...r]);
      rows[6] = ["Sat, 10/17", "RPG", "111", "5:00 PM", "7:00 PM", "TRUE", "TRUE", "FALSE", "2", "--", "TRUE"];
      adapter = createKitchenAdapter({
        sheetsClient: makeSheets(rows), spreadsheetId: "K1", tab: "FH-Kitchen-RSVP", link: "https://kitchen",
        now: () => new Date("2026-10-14T12:00:00Z"),
      });
      expect((await adapter.cancel(ref)).status).toBe("cancelled");
    });

    it("clears with the member's Sheets client but reads with the bot's", async () => {
      const member = { spreadsheets: { values: { clear: vi.fn().mockResolvedValue({}) } } };
      const res = await adapter.cancel(ref, { clients: { sheetsClient: member } });
      expect(res.status).toBe("cancelled");
      expect(member.spreadsheets.values.clear).toHaveBeenCalledWith({ spreadsheetId: "K1", range: "'FH-Kitchen-RSVP'!B7:P7" });
      expect(sheets.spreadsheets.values.clear).not.toHaveBeenCalled();
    });
  });
});
