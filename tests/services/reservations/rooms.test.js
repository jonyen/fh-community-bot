// tests/services/reservations/rooms.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoomsAdapter } from "../../../src/services/reservations/rooms.js";

const ROWS = [
  ["Bros LG", "Tue, 10/20/26", "6:00:00 PM", "9:00 PM", "Alex", "Alex", "L120"],
  ["Rally", "Sat, 10/24/26", "12:30:00 PM", "4:30 PM", "FFX", "Rick", "MPR, parking lot", "Approved"],
  ["Old ask", "Sat, 10/24/26", "1:00:00 PM", "2:00 PM", "RPG", "Julie", "MPR", "Denied"],
  ["Whole building", "Sun, 10/25/26", "", "", "Mgmt", "Vincent", "All FH"],
  ["AYM Xmas Event"],
];

function makeSheets(rows = ROWS) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values: rows } }),
        append: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("rooms adapter", () => {
  let sheets;
  let adapter;
  beforeEach(() => {
    sheets = makeSheets();
    adapter = createRoomsAdapter({
      sheetsClient: sheets, spreadsheetId: "S1", tab: "Upcoming Room Requests",
      link: "https://rooms", now: () => new Date("2026-10-14T12:00:00Z"),
    });
  });

  it("reads the tab from row 2", async () => {
    await adapter.listReservations({ from: "2026-10-19", to: "2026-10-25" });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "S1", range: "'Upcoming Room Requests'!A2:I",
    });
  });

  it("lists active rows in the range, skipping denied and incomplete rows", async () => {
    const { reservations, errors } = await adapter.listReservations({ from: "2026-10-19", to: "2026-10-25" });
    expect(errors).toEqual([]);
    expect(reservations.map((r) => r.title)).toEqual(["Bros LG", "Rally", "Whole building"]);
    expect(reservations[1]).toEqual({
      category: "rooms", item: "MPR, Parking Lot", date: "2026-10-24", start: 750, end: 990,
      title: "Rally", holder: "Rick", holderUserId: null, holderEmail: null,
    });
  });

  it("filters the list by room when items are given", async () => {
    const { reservations } = await adapter.listReservations({
      from: "2026-10-19", to: "2026-10-25", items: [{ label: "L120" }],
    });
    expect(reservations.map((r) => r.title)).toEqual(["Bros LG", "Whole building"]);
  });

  it("finds an overlapping booking of a shared room", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-24", start: 840, end: 900, items: [{ label: "Parking Lot" }] });
    expect(hits.map((h) => h.title)).toEqual(["Rally"]);
  });

  it("ignores denied rows and non-overlapping times", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-24", start: 990, end: 1080, items: [{ label: "MPR" }] });
    expect(hits).toEqual([]);
  });

  it("All FH blocks every room all day", async () => {
    const hits = await adapter.findConflicts({ date: "2026-10-25", start: 600, end: 660, items: [{ label: "Youth Room" }] });
    expect(hits.map((h) => h.title)).toEqual(["Whole building"]);
  });

  it("appends a row with blank status", async () => {
    const res = await adapter.book({
      date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }, { label: "Parking Lot" }],
      title: "Youth night", ministry: "AYM", requesterName: "Deandra Shim",
    });
    expect(res).toEqual({ status: "booked", link: "https://rooms" });
    expect(sheets.spreadsheets.values.append).toHaveBeenCalledWith({
      spreadsheetId: "S1",
      range: "'Upcoming Room Requests'!A:I",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [["Youth night", "Wed, 10/28/26", "7:00 PM", "9:00 PM", "AYM", "Deandra Shim", "MPR\nParking Lot", "", "Booked via #reservations"]],
      },
    });
  });
});
