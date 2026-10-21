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
        update: vi.fn().mockResolvedValue({}),
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
      title: "Rally", holder: "Rick", holderName: "Rick", holderUserId: null, holderEmail: null,
      ref: {
        backend: "rooms", date: "2026-10-24", start: 750, end: 990, title: "Rally", holder: "Rick",
        rooms: ["MPR", "Parking Lot"],
      },
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

  it("checks many dates with one read of the sheet", async () => {
    const res = await adapter.checkDates({
      dates: ["2026-10-24", "2026-10-31"], start: 840, end: 900, items: [{ label: "Parking Lot" }],
    });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    expect(Object.keys(res)).toEqual(["2026-10-24", "2026-10-31"]);
    expect(res["2026-10-24"].conflicts.map((c) => c.title)).toEqual(["Rally"]);
    expect(res["2026-10-24"].unavailable).toBeNull();
    expect(res["2026-10-31"]).toEqual({ conflicts: [], unavailable: null });
  });

  it("appends a row with blank status", async () => {
    const res = await adapter.book({
      date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }, { label: "Parking Lot" }],
      title: "Youth night", ministry: "AYM", requesterName: "Deandra Shim",
    });
    expect(res).toEqual({
      status: "booked", link: "https://rooms",
      ref: {
        backend: "rooms", date: "2026-10-28", start: 1140, end: 1260, title: "Youth night", holder: "Deandra Shim",
        rooms: ["MPR", "Parking Lot"],
      },
    });
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

  it("writes user text so Sheets can't read it as a formula (review fix)", async () => {
    await adapter.book({
      date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }],
      title: "=IMAGE(\"http://x\")", ministry: "+AYM", requesterName: "-Bob",
    });
    const row = sheets.spreadsheets.values.append.mock.calls[0][0].requestBody.values[0];
    expect(row[0]).toBe("'=IMAGE(\"http://x\")");
    expect(row[4]).toBe("'+AYM");
    expect(row[5]).toBe("'-Bob");
  });

  it("appends with the member's Sheets client when given, still reading with the bot's", async () => {
    const member = { spreadsheets: { values: { append: vi.fn().mockResolvedValue({}) } } };
    await adapter.book(
      { date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }], title: "T", ministry: "", requesterName: "D" },
      { clients: { sheetsClient: member } }
    );
    expect(member.spreadsheets.values.append).toHaveBeenCalledTimes(1);
    expect(sheets.spreadsheets.values.append).not.toHaveBeenCalled();
  });

  it("treats Canceled rows as free", async () => {
    const rows = [...ROWS, ["Gone", "Sat, 10/24/26", "5:00:00 PM", "6:00 PM", "X", "Zed", "MPR", "Canceled"]];
    const a = createRoomsAdapter({
      sheetsClient: makeSheets(rows), spreadsheetId: "S1", tab: "Upcoming Room Requests",
      link: "https://rooms", now: () => new Date("2026-10-14T12:00:00Z"),
    });
    expect(await a.findConflicts({ date: "2026-10-24", start: 1020, end: 1080, items: [{ label: "MPR" }] }))
      .toEqual([]);
    const { reservations } = await a.listReservations({ from: "2026-10-24", to: "2026-10-24" });
    expect(reservations.map((r) => r.title)).toEqual(["Rally"]);
  });

  describe("cancel", () => {
    const REF = {
      backend: "rooms", date: "2026-10-24", start: 750, end: 990, title: "Rally", holder: "Rick",
      rooms: ["Parking Lot", "MPR"],
    };
    const adapterFor = (rows) => {
      const s = makeSheets(rows);
      return {
        s,
        a: createRoomsAdapter({
          sheetsClient: s, spreadsheetId: "S1", tab: "Upcoming Room Requests",
          link: "https://rooms", now: () => new Date("2026-10-14T12:00:00Z"),
        }),
      };
    };

    it("writes Canceled into H of the matching row only", async () => {
      const res = await adapter.cancel(REF);
      expect(sheets.spreadsheets.values.update).toHaveBeenCalledTimes(1);
      expect(sheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "S1", range: "'Upcoming Room Requests'!H3", valueInputOption: "RAW",
        requestBody: { values: [["Canceled"]] },
      });
      expect(res).toEqual({ status: "cancelled", link: "https://rooms" });
    });

    it("ignores Status and notes when matching", async () => {
      const rows = [["Rally", "Sat, 10/24/26", "12:30:00 PM", "4:30 PM", "FFX", "Rick", "MPR, parking lot", "Approved", "moved a table"]];
      const { s, a } = adapterFor(rows);
      expect((await a.cancel(REF)).status).toBe("cancelled");
      expect(s.spreadsheets.values.update.mock.calls[0][0].range).toBe("'Upcoming Room Requests'!H2");
    });

    it("returns already for a row that is already Canceled and writes nothing", async () => {
      const rows = [["Rally", "Sat, 10/24/26", "12:30:00 PM", "4:30 PM", "FFX", "Rick", "MPR, parking lot", "Canceled"]];
      const { s, a } = adapterFor(rows);
      expect(await a.cancel(REF)).toEqual({ status: "already", link: "https://rooms" });
      expect(s.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it("returns changed when the title or time was edited, and writes nothing", async () => {
      for (const edit of [{ title: "Rally 2" }, { end: 1020 }, { holder: "Ricky" }, { rooms: ["MPR"] }]) {
        expect(await adapter.cancel({ ...REF, ...edit })).toEqual({ status: "changed", link: "https://rooms" });
      }
      expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it("two identical rows: first cancel marks one, second marks the other", async () => {
      const row = ["Rally", "Sat, 10/24/26", "12:30:00 PM", "4:30 PM", "FFX", "Rick", "MPR, parking lot"];
      const rows = [row, [...row]];
      const { s, a } = adapterFor(rows);
      await a.cancel(REF);
      rows[0] = [...row.slice(0, 7), "Canceled"]; // the sheet now shows the first as canceled
      s.spreadsheets.values.get.mockResolvedValue({ data: { values: rows } });
      await a.cancel(REF);
      const ranges = s.spreadsheets.values.update.mock.calls.map((c) => c[0].range);
      expect(ranges).toEqual(["'Upcoming Room Requests'!H2", "'Upcoming Room Requests'!H3"]);
    });

    it("uses the member's sheets client when given", async () => {
      const member = { spreadsheets: { values: { update: vi.fn().mockResolvedValue({}) } } };
      const res = await adapter.cancel(REF, { clients: { sheetsClient: member } });
      expect(res.status).toBe("cancelled");
      expect(member.spreadsheets.values.update).toHaveBeenCalledTimes(1);
      expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it("book's ref equals the ref a later read of the row produces", async () => {
      const input = {
        date: "2026-10-28", start: 1140, end: 1260, items: [{ label: "MPR" }, { label: "Parking Lot" }],
        title: " =Youth night ", ministry: "AYM", requesterName: " -Bob ",
      };
      const { ref } = await adapter.book(input);
      const written = sheets.spreadsheets.values.append.mock.calls[0][0].requestBody.values[0];
      // Sheets stores the apostrophe-prefixed text literally, so a read returns it without the apostrophe.
      const stored = [written[0].replace(/^'/, ""), "Wed, 10/28/26", "7:00 PM", "9:00 PM", "AYM", written[5].replace(/^'/, ""), written[6]];
      sheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [stored] } });
      const { reservations } = await adapter.listReservations({ from: "2026-10-28", to: "2026-10-28" });
      expect(reservations[0].ref).toEqual(ref);
    });
  });
});
