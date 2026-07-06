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
            ["4/1/2026", "Alice", "Lobby printer jammed", "High", "5", "Bob", "Open", "", "", "Structural"],
            ["4/2/2026", "Charlie", "AC broken in room 3", "Medium", "3", "Dave", "Completed", "Fixed", "", "HVAC"],
            ["4/3/2026", "Eve", "Elevator stuck on floor 2", "Low", "1", "Frank", "Done", "", "", "Electrical"],
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
          photos: "",
          type: "Structural",
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

    it("writes photo links when photos are present", async () => {
      await service.appendIssue({
        reporter: "U789",
        description: "Water leak",
        severity: "Medium",
        photos: [
          { viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
          { viewUrl: "https://drive.google.com/file/d/B/view", name: "b.jpg" },
        ],
      });

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          range: "'Maintenance Request'!A5:J5",
          requestBody: {
            values: [[
              expect.any(String), "U789", "Water leak", "Medium", "=TODAY()-A5", "", "Need to Assign", "",
              "https://drive.google.com/file/d/A/view\nhttps://drive.google.com/file/d/B/view", "",
            ]],
          },
        })
      );
    });

    it("writes the issue type into column J", async () => {
      await service.appendIssue({
        reporter: "Test User",
        description: "leak under sink",
        severity: "Medium",
        type: "Plumbing",
      });

      const updateCall = mockSheets.spreadsheets.values.update.mock.calls[0][0];
      expect(updateCall.range).toBe("'Maintenance Request'!A5:J5");
      const row = updateCall.requestBody.values[0];
      expect(row).toHaveLength(10);
      expect(row[9]).toBe("Plumbing");
    });

    it("writes an empty TYPE cell when type is omitted", async () => {
      await service.appendIssue({
        reporter: "Test User",
        description: "leak under sink",
        severity: "Medium",
      });

      const row = mockSheets.spreadsheets.values.update.mock.calls[0][0].requestBody.values[0];
      expect(row[9]).toBe("");
    });
  });

  describe("appendPhotos", () => {
    it("writes links into the photos cell when empty", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [[""]] } });

      await service.appendPhotos("5", [
        { viewUrl: "https://drive.google.com/file/d/A/view", name: "a.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5",
      });
      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "'Maintenance Request'!I5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["https://drive.google.com/file/d/A/view"]],
        },
      });
    });

    it("appends to existing links", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [["https://drive.google.com/file/d/OLD/view"]] },
      });

      await service.appendPhotos("5", [
        { viewUrl: "https://drive.google.com/file/d/NEW/view", name: "new.jpg" },
      ]);

      expect(mockSheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            values: [[
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
            ["4/1/2026", "Alice", "Printer jammed", "", "", "", "Open", "", "", "Structural"],
            ["4/2/2026", "Charlie", "AC broken", "", "", "", "Completed", "", "", "HVAC"],
          ],
        },
      });

      const issues = await service.getAllIssues();
      expect(issues).toHaveLength(2);
    });
  });
});
