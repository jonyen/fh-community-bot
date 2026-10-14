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
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1020, end: 1140, title: "RPG", holder: "RPG (111)", holderUserId: null, holderEmail: null },
      { category: "kitchen", item: "Kitchen", date: "2026-10-17", start: 1080, end: 1200, title: "AYM", holder: "AYM (222)", holderUserId: null, holderEmail: null },
    ]);
  });

  it("has no conflict while fewer than 3 groups overlap", async () => {
    expect(await adapter.findConflicts({ date: "2026-10-17", start: 1080, end: 1140, items: [] })).toEqual([]);
  });

  it("conflicts when 3 groups already overlap, returning all three", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-18", start: 1080, end: 1110, items: [] });
    expect(hits.map((h) => h.title)).toEqual(["A", "B", "C"]);
  });

  it("fills the first empty row for the date, only touching requested appliances", async () => {
    const res = await adapter.book({
      date: "2026-10-17", start: 1020, end: 1080, requesterName: "Jina Kim", phone: "555-0100",
      appliances: { airFryer: true, largeRiceCooker: 2 },
    });
    expect(res).toEqual({ status: "booked", link: "https://kitchen" });
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
});
