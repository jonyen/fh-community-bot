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
          update: vi.fn(),
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
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
            ["1", "2026-04-01T10:00:00Z", "U123", "Lobby printer jammed", "open", "Try restarting", "https://slack.com/msg1", ""],
            ["2", "2026-04-02T10:00:00Z", "U456", "AC broken in room 3", "resolved", "", "https://slack.com/msg2", "2026-04-03"],
          ],
        },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([
        {
          id: "1",
          timestamp: "2026-04-01T10:00:00Z",
          reporter: "U123",
          description: "Lobby printer jammed",
          status: "open",
          aiSuggestion: "Try restarting",
          messageLink: "https://slack.com/msg1",
          resolvedDate: "",
        },
      ]);
    });

    it("returns empty array when sheet has only headers", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
          ],
        },
      });

      const issues = await service.getOpenIssues();
      expect(issues).toEqual([]);
    });
  });

  describe("appendIssue", () => {
    it("appends a new row and returns the assigned ID", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [["ID"], ["1"], ["2"]] },
      });
      mockSheets.spreadsheets.values.append.mockResolvedValue({});

      const id = await service.appendIssue({
        reporter: "U789",
        description: "Water leak in bathroom",
        aiSuggestion: "Check the faucet",
        messageLink: "https://slack.com/msg3",
      });

      expect(id).toBe("3");
      expect(mockSheets.spreadsheets.values.append).toHaveBeenCalledWith({
        spreadsheetId: "sheet-id",
        range: "Sheet1!A:H",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["3", expect.any(String), "U789", "Water leak in bathroom", "open", "Check the faucet", "https://slack.com/msg3", ""]],
        },
      });
    });
  });

  describe("getAllIssues", () => {
    it("returns all issues regardless of status", async () => {
      mockSheets.spreadsheets.values.get.mockResolvedValue({
        data: {
          values: [
            ["ID", "Timestamp", "Reporter", "Description", "Status", "AI Suggestion", "Message Link", "Resolved Date"],
            ["1", "2026-04-01T10:00:00Z", "U123", "Printer jammed", "open", "", "", ""],
            ["2", "2026-04-02T10:00:00Z", "U456", "AC broken", "resolved", "", "", "2026-04-03"],
          ],
        },
      });

      const issues = await service.getAllIssues();
      expect(issues).toHaveLength(2);
    });
  });
});
