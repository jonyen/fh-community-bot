// tests/services/onestopInfo.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOneStopInfoService } from "../../src/services/onestopInfo.js";

describe("OneStopInfoService", () => {
  let mockSheets, clock, service;
  beforeEach(() => {
    clock = 0;
    mockSheets = { spreadsheets: { values: { get: vi.fn(async ({ range }) => {
      if (range.startsWith("'BULLETIN'")) return { data: { values: [
        ["Subject", "Details"], ["FH Door code", "0326"], ["", ""],
      ] } };
      if (range.startsWith("'Links'")) return { data: { values: [
        ["DMV Travel Workspace", "Wanda Stucki"],
      ] } };
      if (range.startsWith("'Boom'")) throw new Error("no such tab");
      return { data: { values: [] } };
    }) } } };
    service = createOneStopInfoService({
      sheetsClient: mockSheets, sheetId: "OS1",
      tabs: ["BULLETIN", "Links", "Boom"], ttlMs: 1000,
      now: () => new Date(clock),
    });
  });

  it("renders allowlisted tabs, skips empty rows, skips an erroring tab", async () => {
    const text = await service.corpus();
    expect(text).toContain("### BULLETIN");
    expect(text).toContain("FH Door code | 0326");
    expect(text).toContain("### Links");
    expect(text).toContain("DMV Travel Workspace | Wanda Stucki");
    expect(text).not.toContain("### Boom"); // erroring tab skipped
    expect(text).not.toMatch(/\n\s*\|\s*\n/); // no all-empty row rendered
  });

  it("only requests the configured tabs (never an excluded tab)", async () => {
    await service.corpus();
    const ranges = mockSheets.spreadsheets.values.get.mock.calls.map((c) => c[0].range);
    expect(ranges.some((r) => r.startsWith("'Config'"))).toBe(false);
    expect(ranges.some((r) => r.startsWith("'BULLETIN'"))).toBe(true);
  });

  it("caches within the TTL and refetches after it", async () => {
    await service.corpus();
    await service.corpus();
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(3); // 3 tabs, one round
    clock = 2000; // past ttl
    await service.corpus();
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(6);
  });

  it("does not cache an empty corpus (retries on all-tab failure)", async () => {
    // Make all tabs error
    mockSheets.spreadsheets.values.get = vi.fn(async () => {
      throw new Error("sheets down");
    });
    const result1 = await service.corpus();
    expect(result1).toBe("");
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(3); // 3 tabs tried

    // Second call should retry, not return cached empty
    const result2 = await service.corpus();
    expect(result2).toBe("");
    expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledTimes(6); // 3 more tabs tried
  });
});
