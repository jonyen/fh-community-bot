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
          slackRef: "",
          slackLink: "",
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
        range: "'Maintenance Request'!A5:L5",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[expect.any(String), "U789", "Water leak in bathroom", "", "=TODAY()-A5", "", "Need to Assign", "", "", "", "", ""]],
        },
      });
    });

    it("writes a link back to the Slack thread into column L", async () => {
      await service.appendIssue({
        reporter: "Test User",
        description: "outlet cover popping out",
        severity: "Minor",
        type: "Electrical",
        slackRef: "1788883645.693749",
        slackLink: "https://example.slack.com/archives/C072CCD520K/p1788883645693749",
      });

      const call = mockSheets.spreadsheets.values.update.mock.calls[0][0];
      expect(call.range).toBe("'Maintenance Request'!A5:L5");
      expect(call.requestBody.values[0][11]).toBe(
        "https://example.slack.com/archives/C072CCD520K/p1788883645693749"
      );
    });

    it("writes the Slack ref as text so Sheets cannot round it into a number", async () => {
      // Written plainly, USER_ENTERED parses "1788883645.693749" as a number
      // and reads back as "1788883646" — which never matches the ts we look
      // rows up by, so every thread reply and replay guard missed its row.
      await service.appendIssue({
        reporter: "Test User",
        description: "outlet cover popping out",
        slackRef: "1788883645.693749",
      });

      const call = mockSheets.spreadsheets.values.update.mock.calls[0][0];
      expect(call.requestBody.values[0][10]).toBe("'1788883645.693749");
    });

    it("leaves the link cell empty when there is no permalink", async () => {
      await service.appendIssue({ reporter: "Test User", description: "no link" });
      const call = mockSheets.spreadsheets.values.update.mock.calls[0][0];
      expect(call.requestBody.values[0][11]).toBe("");
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
          range: "'Maintenance Request'!A5:L5",
          requestBody: {
            values: [[
              expect.any(String), "U789", "Water leak", "Medium", "=TODAY()-A5", "", "Need to Assign", "",
              "https://drive.google.com/file/d/A/view\nhttps://drive.google.com/file/d/B/view", "", "", "",
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
      expect(updateCall.range).toBe("'Maintenance Request'!A5:L5");
      const row = updateCall.requestBody.values[0];
      expect(row).toHaveLength(12);
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

    it("writes the slack ref into column K", async () => {
      await service.appendIssue({
        reporter: "Test User",
        description: "leak under sink",
        severity: "Medium",
        slackRef: "1720000000.123456",
      });

      const updateCall = mockSheets.spreadsheets.values.update.mock.calls[0][0];
      expect(updateCall.range).toBe("'Maintenance Request'!A5:L5");
      const row = updateCall.requestBody.values[0];
      expect(row).toHaveLength(12);
      // Apostrophe-prefixed so Sheets keeps the ts as text (see slackRefCell).
      expect(row[10]).toBe("'1720000000.123456");
    });

    it("writes an empty SLACK_REF cell when slackRef is omitted", async () => {
      await service.appendIssue({
        reporter: "Test User",
        description: "leak under sink",
      });

      const row = mockSheets.spreadsheets.values.update.mock.calls[0][0].requestBody.values[0];
      expect(row[10]).toBe("");
    });
  });

  describe("findIssueRowByRef", () => {
    it("returns the current row number for a matching ref", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["4/1/2026", "Alice", "Printer jammed", "", "", "", "Open", "", "", "", "1720000000.111111"],
            ["4/2/2026", "Charlie", "AC broken", "", "", "", "Open", "", "", "", "1720000000.222222"],
          ],
        },
      });

      await expect(service.findIssueRowByRef("1720000000.222222")).resolves.toBe("6");
    });

    it("matches a legacy row whose ref was stored as a rounded number", async () => {
      // Rows written before the ref was stored as text read back rounded to
      // the second. Fall back to a to-the-second comparison so notes, photos
      // and the duplicate-submit guard still find those rows.
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["9/8/2026", "Sarah Chu", "outlet cover", "", "", "", "Open", "", "", "", "1788883646"],
          ],
        },
      });

      await expect(service.findIssueRowByRef("1788883645.693749")).resolves.toBe("5");
    });

    it("does not match a legacy row more than a second away", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["9/8/2026", "Sarah Chu", "outlet cover", "", "", "", "Open", "", "", "", "1788883646"],
          ],
        },
      });

      await expect(service.findIssueRowByRef("1788883648.100000")).resolves.toBeNull();
    });

    it("returns null when no row matches", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [["4/1/2026", "Alice", "Printer jammed", "", "", "", "Open", "", "", "", "1720000000.111111"]],
        },
      });

      await expect(service.findIssueRowByRef("1720000000.999999")).resolves.toBeNull();
    });

    it("never matches rows with a blank ref", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["4/1/2026", "Alice", "Human-entered row", "", "", "", "Open", "", "", ""],
            ["IN PROGRESS"],
          ],
        },
      });

      await expect(service.findIssueRowByRef("")).resolves.toBeNull();
      await expect(service.findIssueRowByRef(undefined)).resolves.toBeNull();
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
