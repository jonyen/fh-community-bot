import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSheetsService } from "../../src/services/sheets.js";

describe("SheetsService", () => {
  let mockSheets;
  let service;

  beforeEach(() => {
    mockSheets = {
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: {
            sheets: [{ properties: { title: "Maintenance Request", sheetId: 0 } }],
          },
        }),
        batchUpdate: vi.fn().mockResolvedValue({}),
        values: {
          get: vi.fn(),
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
            ["4/3/2026", "Eve", "Elevator stuck on floor 2", "Low", "1", "Frank", "Done", ""],
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
          photoThumb: "",
          photoLinks: "",
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
    it("inserts a row at row 5 and returns the row number", async () => {
      const id = await service.appendIssue({
        reporter: "U789",
        description: "Water leak in bathroom",
      });

      expect(id).toBe("5");
      expect(mockSheets.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 5 },
              },
            },
          ],
        },
      });
      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!A5:J5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[expect.any(String), "U789", "Water leak in bathroom", "", "=TODAY()-A5", "", "Need to Assign", "", "", ""]],
        },
      });
    });

    it("writes a thumbnail formula and links when photos are present", async () => {
      await service.appendIssue({
        reporter: "U789",
        description: "Water leak",
        severity: "Medium",
        photos: [
          { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
          { imageUrl: "https://lh3.googleusercontent.com/d/B", viewUrl: "https://drive.google.com/file/d/B/view", name: "b.jpg" },
        ],
      });

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          range: "'Maintenance Request'!A5:J5",
          requestBody: {
            values: [[
              expect.any(String), "U789", "Water leak", "Medium", "=TODAY()-A5", "", "Need to Assign", "",
              '=IMAGE("https://lh3.googleusercontent.com/d/A")',
              "https://drive.google.com/file/d/A/view\nhttps://drive.google.com/file/d/B/view",
            ]],
          },
        })
      );
    });
  });

  describe("appendPhotos", () => {
    it("sets the thumbnail when empty and appends links", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [["", ""]] } });

      await service.appendPhotos("5", [
        { imageUrl: "https://lh3.googleusercontent.com/d/A", viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5:J5",
        valueRenderOption: "FORMULA",
      });
      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5:J5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [['=IMAGE("https://lh3.googleusercontent.com/d/A")', "https://drive.google.com/file/d/A/view"]],
        },
      });
    });

    it("keeps the existing thumbnail and appends to existing links", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['=IMAGE("https://lh3.googleusercontent.com/d/OLD")', "https://drive.google.com/file/d/OLD/view"]] },
      });

      await service.appendPhotos("5", [
        { imageUrl: "https://lh3.googleusercontent.com/d/NEW", viewUrl: "https://drive.google.com/file/d/NEW/view", name: "new.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            values: [[
              '=IMAGE("https://lh3.googleusercontent.com/d/OLD")',
              "https://drive.google.com/file/d/OLD/view\nhttps://drive.google.com/file/d/NEW/view",
            ]],
          },
        })
      );
    });

    it("does nothing when there are no photos", async () => {
      await service.appendPhotos("5", []);
      expect(mockSheets.spreadsheets.values.update).not.toHaveBeenCalled();
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
