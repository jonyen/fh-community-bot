import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSheetsService } from "../../src/services/sheets.js";

describe("SheetsService", () => {
  let mockSheets;
  let service;

  beforeEach(() => {
    mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn(),
          append: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
      },
    };
    service = createSheetsService(mockSheets, "sheet-id");
  });

  describe("getOpenIssues", () => {
    it("returns open issues parsed from sheet rows", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["4/1/2026", "Alice", "Lobby printer jammed", "High", "5", "Bob", "Open", ""],
            ["4/2/2026", "Charlie", "AC broken in room 3", "Medium", "3", "Dave", "Completed", "Fixed"],
          ],
        },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([
        {
          id: "5",
          date: "4/1/2026",
          submitter: "Alice",
          description: "Lobby printer jammed",
          priority: "High",
          daysSinceFiled: "5",
          inCharge: "Bob",
          status: "Open",
          notes: "",
        },
      ]);
    });

    it("returns empty array when sheet has no data rows", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [] },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([]);
    });
  });

  describe("appendIssue", () => {
    it("appends a new row and returns the row number", async () => {
      mockSheets.spreadsheets.values.append.mockResolvedValue({});
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [["row1"], ["row2"], ["row3"]] },
      });

      const id = await service.appendIssue({
        reporter: "U789",
        description: "Water leak in bathroom",
      });

      expect(id).toBe("7");
      expect(mockSheets.spreadsheets.values.append).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!A5:H",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[expect.any(String), "U789", "Water leak in bathroom", "", "", "", "Open", ""]],
        },
      });
    });
  });

  describe("updateIssueStatus", () => {
    it("updates column G for the given row", async () => {
      await service.updateIssueStatus("7", "Resolved");

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!G7",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["Resolved"]],
        },
      });
    });
  });

  describe("getAllIssues", () => {
    it("returns all issues regardless of status", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["4/1/2026", "Alice", "Printer jammed", "", "", "", "Open", ""],
            ["4/2/2026", "Charlie", "AC broken", "", "", "", "Completed", ""],
          ],
        },
      });

      const issues = await service.getAllIssues();
      expect(issues).toHaveLength(2);
    });
  });
});
