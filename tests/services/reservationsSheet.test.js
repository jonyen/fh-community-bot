// tests/services/reservationsSheet.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReservationsSheetService } from "../../src/services/reservationsSheet.js";

describe("ReservationsSheetService", () => {
  let mockSheets;
  let service;
  beforeEach(() => {
    mockSheets = {
      spreadsheets: {
        get: vi.fn(),
        values: { get: vi.fn(), update: vi.fn().mockResolvedValue({}) },
        batchUpdate: vi.fn().mockResolvedValue({}),
      },
    };
    service = createReservationsSheetService(mockSheets, "SHEET1");
  });

  it("listScheduleTabs keeps only schedule tabs", async () => {
    mockSheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [
        { properties: { title: "BULLETIN", sheetId: 1 } },
        { properties: { title: "6/22-6/26 M-F", sheetId: 2 } },
        { properties: { title: "6/27-6/28 S-Su", sheetId: 3 } },
      ] },
    });
    expect(await service.listScheduleTabs()).toEqual(["6/22-6/26 M-F", "6/27-6/28 S-Su"]);
  });

  it("readWeekEvents parses rows, skips header and blanks", async () => {
    mockSheets.spreadsheets.values.get.mockResolvedValue({
      data: { values: [
        ["DATE", "START TIME", "END TIME", "TRIBE", "MINISTRY", "WHAT", "LOCATION"],
        ["6/24 Wed", "1:00 PM", "2:00 PM", "", "", "Worktime", "Management office"],
        [],
        ["6/24 Wed", "", "", "", "", "TBD thing", "Various"],
      ] },
    });
    const events = await service.readWeekEvents("6/22-6/26 M-F");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      rowIndex: 1, date: { month: 6, day: 24 }, startMin: 13 * 60, endMin: 14 * 60,
      allDay: false, location: "Management office", what: "Worktime",
    });
    expect(events[1]).toMatchObject({ rowIndex: 3, startMin: null, endMin: null });
  });

  it("insertRow inserts a dimension then writes padded values", async () => {
    mockSheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "6/22-6/26 M-F", sheetId: 7 } }] },
    });
    await service.insertRow("6/22-6/26 M-F", 2, ["6/24 Wed", "3:00 PM", "4:00 PM", "", "", "Meeting", "FH MPR"]);
    expect(mockSheets.spreadsheets.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      spreadsheetId: "SHEET1",
      requestBody: { requests: [{ insertDimension: {
        range: { sheetId: 7, dimension: "ROWS", startIndex: 2, endIndex: 3 }, inheritFromBefore: true,
      } }] },
    }));
    const updateArg = mockSheets.spreadsheets.values.update.mock.calls[0][0];
    expect(updateArg.range).toBe("'6/22-6/26 M-F'!A3:L3");
    expect(updateArg.requestBody.values[0]).toHaveLength(12);
  });
});
