import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderMapService } from "../../src/services/genderMap.js";

function makeSheetsClient(values) {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({ data: { values } }),
      },
    },
  };
}

describe("createGenderMapService", () => {
  let sheets;
  let service;

  beforeEach(() => {
    sheets = makeSheetsClient([
      ["25", "male", "andrew@example.com", "U01ABC123"],
      ["51", "FEMALE", "billy@example.com", "U02DEF456"],
      ["52", "Other", "bliss@example.com", "U03GHI789"],
      ["53", "male", "bo@example.com", ""],
      ["54", "male", "blank-slack-col"],
      ["55", "male", "trailing-space@example.com", "  U05WHITESPACE  "],
    ]);
    service = createGenderMapService({
      sheetsClient: sheets,
      spreadsheetId: "sheet-1",
      ttlMs: 7 * 24 * 3600 * 1000,
      tabName: "Gender Map",
    });
  });

  it("parses valid rows, keys by slack_id, normalizes gender to lowercase, skips malformed", async () => {
    const map = await service.getMap();
    expect(map).toEqual({
      U01ABC123: "male",
      U02DEF456: "female",
      U05WHITESPACE: "male",
    });
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "'Gender Map'!A2:D",
    });
  });

  it("returns cached map on second call within TTL", async () => {
    await service.getMap();
    await service.getMap();
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a refetch and returns the entry count", async () => {
    await service.getMap();
    const count = await service.invalidate();
    expect(count).toBe(3);
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(2);
  });

  it("refetches after TTL expiry", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    const svc = createGenderMapService({
      sheetsClient: sheets,
      spreadsheetId: "sheet-1",
      ttlMs: 1000,
      tabName: "Gender Map",
    });

    await svc.getMap();
    vi.setSystemTime(t0 + 1500);
    await svc.getMap();
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("treats empty values array as empty map", async () => {
    const emptySheets = makeSheetsClient(undefined);
    const svc = createGenderMapService({
      sheetsClient: emptySheets,
      spreadsheetId: "sheet-1",
      ttlMs: 1000,
      tabName: "Gender Map",
    });
    expect(await svc.getMap()).toEqual({});
  });
});
