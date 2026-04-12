import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIssueProcessor, extractSeverity } from "../../src/core/issue-processor.js";

function recentDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-US");
}

describe("extractSeverity", () => {
  it("returns null severity when no severity in text", () => {
    const result = extractSeverity("lobby printer jammed");
    expect(result).toEqual({ description: "lobby printer jammed", severity: null });
  });

  it("extracts trailing severity with dash separator", () => {
    const result = extractSeverity("lobby printer jammed - critical");
    expect(result).toEqual({ description: "lobby printer jammed", severity: "Critical" });
  });

  it("extracts severity with 'priority' suffix", () => {
    const result = extractSeverity("sink leaking medium priority");
    expect(result).toEqual({ description: "sink leaking", severity: "Medium" });
  });

  it("extracts severity with 'severity:' prefix", () => {
    const result = extractSeverity("broken window severity: minor");
    expect(result).toEqual({ description: "broken window", severity: "Minor" });
  });

  it("capitalizes the severity", () => {
    const result = extractSeverity("something broke - CRITICAL");
    expect(result).toEqual({ description: "something broke", severity: "Critical" });
  });
});

describe("createIssueProcessor", () => {
  let sheetsService;
  let groqService;
  let dedupService;
  let conversationService;
  let processor;

  beforeEach(() => {
    sheetsService = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("42"),
      appendNote: vi.fn().mockResolvedValue({}),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
    };
    groqService = {
      isMaintenanceRequest: vi.fn().mockResolvedValue(true),
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
    };
    dedupService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    conversationService = {
      getConversation: vi.fn().mockResolvedValue(null),
      saveConversation: vi.fn().mockResolvedValue({}),
      deleteConversation: vi.fn().mockResolvedValue({}),
    };

    processor = createIssueProcessor({
      sheetsService,
      groqService,
      dedupService,
      conversationService,
      spreadsheetId: "sheet-id",
    });
  });

  // ─── processNewReport ────────────────────────────────────────────────────────

  describe("processNewReport", () => {
    it("returns awaiting_severity for normal flow and saves conversation", async () => {
      const result = await processor.processNewReport({
        description: "lobby printer jammed",
        reporterName: "Alice",
        conversationKey: "thread:1",
      });

      expect(result.action).toBe("awaiting_severity");
      expect(result.suggestion).toBe("Try restarting it.");
      expect(result.issueDescription).toBe("lobby printer jammed");
      expect(conversationService.saveConversation).toHaveBeenCalledWith(
        "thread:1",
        expect.objectContaining({
          state: "awaiting_severity",
          reporterName: "Alice",
          issueDescription: "lobby printer jammed",
        })
      );
    });

    it("returns not_maintenance when classification fails", async () => {
      groqService.isMaintenanceRequest.mockResolvedValue(false);

      const result = await processor.processNewReport({
        description: "what's for lunch?",
        reporterName: "Alice",
        conversationKey: "thread:1",
      });

      expect(result.action).toBe("not_maintenance");
      expect(sheetsService.appendIssue).not.toHaveBeenCalled();
    });

    it("returns duplicate_found when confident match found", async () => {
      sheetsService.getOpenIssues.mockResolvedValue([
        { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
      ]);
      dedupService.findDuplicate.mockResolvedValue({ id: "5", confident: true });

      const result = await processor.processNewReport({
        description: "printer is broken",
        reporterName: "Bob",
        conversationKey: "thread:1",
      });

      expect(result.action).toBe("duplicate_found");
      expect(result.existingIssue.id).toBe("5");
      expect(result.issueDescription).toBe("printer is broken");
      expect(sheetsService.appendIssue).not.toHaveBeenCalled();
    });

    it("returns issue_created immediately when inline severity is provided", async () => {
      const result = await processor.processNewReport({
        description: "lobby printer jammed - critical",
        reporterName: "Alice",
        conversationKey: "thread:1",
      });

      expect(result.action).toBe("issue_created");
      expect(result.severity).toBe("Critical");
      expect(result.issueRowId).toBe("42");
      expect(result.issueDescription).toBe("lobby printer jammed");
      expect(sheetsService.appendIssue).toHaveBeenCalledWith({
        reporter: "Alice",
        description: "lobby printer jammed",
        severity: "Critical",
      });
      expect(conversationService.saveConversation).toHaveBeenCalledWith(
        "thread:1",
        expect.objectContaining({ state: "issue_created" })
      );
    });

    it("returns issue_created immediately when severity is passed as parameter", async () => {
      const result = await processor.processNewReport({
        description: "lobby printer jammed",
        reporterName: "Alice",
        conversationKey: "thread:1",
        severity: "Minor",
      });

      expect(result.action).toBe("issue_created");
      expect(result.severity).toBe("Minor");
      expect(sheetsService.appendIssue).toHaveBeenCalledWith({
        reporter: "Alice",
        description: "lobby printer jammed",
        severity: "Minor",
      });
    });

    it("skips classification when forceCreate is true", async () => {
      const result = await processor.processNewReport({
        description: "weird smell in kitchen",
        reporterName: "Alice",
        conversationKey: "thread:1",
        forceCreate: true,
      });

      expect(groqService.isMaintenanceRequest).not.toHaveBeenCalled();
      expect(dedupService.findDuplicate).not.toHaveBeenCalled();
      expect(result.action).toBe("awaiting_severity");
    });

    it("returns sheets_error when getOpenIssues fails", async () => {
      sheetsService.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

      const result = await processor.processNewReport({
        description: "broken window",
        reporterName: "Alice",
        conversationKey: "thread:1",
      });

      expect(result.action).toBe("sheets_error");
      expect(sheetsService.appendIssue).not.toHaveBeenCalled();
    });

    it("only checks recent issues (last 7 days) for dedup", async () => {
      sheetsService.getOpenIssues.mockResolvedValue([
        { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(10), status: "Open" },
      ]);

      await processor.processNewReport({
        description: "printer is broken",
        reporterName: "Bob",
        conversationKey: "thread:1",
      });

      // Should be called with empty array since the issue is older than 7 days
      expect(dedupService.findDuplicate).toHaveBeenCalledWith("printer is broken", []);
    });
  });

  // ─── processSeverityReply ────────────────────────────────────────────────────

  describe("processSeverityReply", () => {
    it("creates issue and returns issue_created with capitalized severity", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "awaiting_severity",
        reporterName: "Alice",
        issueDescription: "printer is jammed",
        suggestion: "Clear the paper tray.",
        duplicate: null,
      });

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "medium",
      });

      expect(result.action).toBe("issue_created");
      expect(result.severity).toBe("Medium");
      expect(result.issueRowId).toBe("42");
      expect(result.suggestion).toBe("Clear the paper tray.");
      expect(sheetsService.appendIssue).toHaveBeenCalledWith({
        reporter: "Alice",
        description: "printer is jammed",
        severity: "Medium",
      });
      expect(conversationService.saveConversation).toHaveBeenCalledWith(
        "thread:1",
        expect.objectContaining({ state: "issue_created", issueRowId: "42" })
      );
    });

    it("returns invalid_severity for bad input", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "awaiting_severity",
        issueDescription: "printer is jammed",
      });

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "urgent",
      });

      expect(result.action).toBe("invalid_severity");
      expect(sheetsService.appendIssue).not.toHaveBeenCalled();
    });

    it("returns no_conversation when no pending state exists", async () => {
      conversationService.getConversation.mockResolvedValue(null);

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "minor",
      });

      expect(result.action).toBe("no_conversation");
    });

    it("returns no_conversation when state is not awaiting_severity", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "issue_created",
        issueRowId: "42",
      });

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "minor",
      });

      expect(result.action).toBe("no_conversation");
    });

    it("returns sheets_error when appendIssue fails", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "awaiting_severity",
        reporterName: "Alice",
        issueDescription: "printer is jammed",
        suggestion: null,
        duplicate: null,
      });
      sheetsService.appendIssue.mockRejectedValue(new Error("Sheets down"));

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "critical",
      });

      expect(result.action).toBe("sheets_error");
    });

    it("accepts severity case-insensitively (CRITICAL, Minor, MEDIUM)", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "awaiting_severity",
        reporterName: "Alice",
        issueDescription: "printer is jammed",
        suggestion: null,
        duplicate: null,
      });

      const result = await processor.processSeverityReply({
        conversationKey: "thread:1",
        severity: "CRITICAL",
      });

      expect(result.action).toBe("issue_created");
      expect(result.severity).toBe("Critical");
    });
  });

  // ─── processFollowUp ─────────────────────────────────────────────────────────

  describe("processFollowUp", () => {
    it("appends note and returns note_added", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "issue_created",
        issueRowId: "42",
        issueDescription: "printer jammed",
      });

      const result = await processor.processFollowUp({
        conversationKey: "thread:1",
        text: "it's the one near the front desk",
      });

      expect(result.action).toBe("note_added");
      expect(sheetsService.appendNote).toHaveBeenCalledWith("42", "it's the one near the front desk");
      // Should refresh TTL by re-saving
      expect(conversationService.saveConversation).toHaveBeenCalledWith(
        "thread:1",
        expect.objectContaining({ issueRowId: "42" })
      );
    });

    it("returns no_conversation when no state exists", async () => {
      conversationService.getConversation.mockResolvedValue(null);

      const result = await processor.processFollowUp({
        conversationKey: "thread:1",
        text: "some extra detail",
      });

      expect(result.action).toBe("no_conversation");
      expect(sheetsService.appendNote).not.toHaveBeenCalled();
    });

    it("returns no_conversation when issueRowId is missing", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "awaiting_severity",
        issueDescription: "printer jammed",
      });

      const result = await processor.processFollowUp({
        conversationKey: "thread:1",
        text: "some extra detail",
      });

      expect(result.action).toBe("no_conversation");
    });

    it("returns sheets_error when appendNote fails", async () => {
      conversationService.getConversation.mockResolvedValue({
        state: "issue_created",
        issueRowId: "42",
      });
      sheetsService.appendNote.mockRejectedValue(new Error("Sheets down"));

      const result = await processor.processFollowUp({
        conversationKey: "thread:1",
        text: "some extra detail",
      });

      expect(result.action).toBe("sheets_error");
    });
  });
});
