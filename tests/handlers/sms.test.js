import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSmsHandler } from "../../src/handlers/sms.js";

function snsEvent(body, originationNumber = "+15551234567") {
  return {
    Records: [
      {
        Sns: {
          Message: JSON.stringify({ messageBody: body, originationNumber }),
        },
      },
    ],
  };
}

describe("createSmsHandler", () => {
  let issueProcessor;
  let conversationService;
  let pinpointService;
  let handleSms;

  beforeEach(() => {
    issueProcessor = {
      processNewReport: vi.fn().mockResolvedValue({ action: "awaiting_severity" }),
      processSeverityReply: vi.fn().mockResolvedValue({ action: "issue_created", severity: "Minor", suggestion: null }),
      processFollowUp: vi.fn().mockResolvedValue({ action: "note_added" }),
    };
    conversationService = {
      getConversation: vi.fn().mockResolvedValue(null),
      saveConversation: vi.fn().mockResolvedValue({}),
      deleteConversation: vi.fn().mockResolvedValue({}),
    };
    pinpointService = {
      sendSms: vi.fn().mockResolvedValue({}),
    };

    handleSms = createSmsHandler({ issueProcessor, conversationService, pinpointService });
  });

  it("starts new issue report when no active conversation", async () => {
    conversationService.getConversation.mockResolvedValue(null);
    issueProcessor.processNewReport.mockResolvedValue({ action: "awaiting_severity" });

    await handleSms(snsEvent("The lobby printer is jammed"));

    expect(issueProcessor.processNewReport).toHaveBeenCalledWith({
      description: "The lobby printer is jammed",
      reporterName: "+15551234567",
      conversationKey: "SMS#+15551234567",
    });
    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("How severe")
    );
  });

  it("processes severity reply when awaiting_severity", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "awaiting_severity" });
    issueProcessor.processSeverityReply.mockResolvedValue({
      action: "issue_created",
      severity: "Minor",
      suggestion: null,
    });

    await handleSms(snsEvent("minor"));

    expect(issueProcessor.processSeverityReply).toHaveBeenCalledWith({
      conversationKey: "SMS#+15551234567",
      severity: "minor",
    });
    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("Logged your issue")
    );
  });

  it("appends follow-up when issue_created", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "issue_created" });
    issueProcessor.processFollowUp.mockResolvedValue({ action: "note_added" });

    await handleSms(snsEvent("it's the printer by the front desk"));

    expect(issueProcessor.processFollowUp).toHaveBeenCalledWith({
      conversationKey: "SMS#+15551234567",
      text: "it's the printer by the front desk",
    });
    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("added")
    );
  });

  it("starts new report when NEW prefix with active conversation", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "issue_created" });
    issueProcessor.processNewReport.mockResolvedValue({ action: "awaiting_severity" });

    await handleSms(snsEvent("NEW sink is leaking in bathroom"));

    expect(conversationService.deleteConversation).toHaveBeenCalledWith("SMS#+15551234567");
    expect(issueProcessor.processNewReport).toHaveBeenCalledWith({
      description: "sink is leaking in bathroom",
      reporterName: "+15551234567",
      conversationKey: "SMS#+15551234567",
    });
  });

  it("sends not-maintenance reply", async () => {
    conversationService.getConversation.mockResolvedValue(null);
    issueProcessor.processNewReport.mockResolvedValue({ action: "not_maintenance" });

    await handleSms(snsEvent("what's for lunch?"));

    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("doesn't look like a maintenance request")
    );
  });

  it("sends error reply when sheets fails", async () => {
    conversationService.getConversation.mockResolvedValue(null);
    issueProcessor.processNewReport.mockResolvedValue({ action: "sheets_error" });

    await handleSms(snsEvent("broken window"));

    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("couldn't process")
    );
  });

  it("sends invalid severity reply", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "awaiting_severity" });
    issueProcessor.processSeverityReply.mockResolvedValue({ action: "invalid_severity" });

    await handleSms(snsEvent("urgent"));

    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("minor, medium, or critical")
    );
  });

  it("sends prompt when body is empty", async () => {
    await handleSms(snsEvent("   "));

    expect(issueProcessor.processNewReport).not.toHaveBeenCalled();
    expect(pinpointService.sendSms).toHaveBeenCalledWith(
      "+15551234567",
      expect.stringContaining("Please describe the maintenance issue")
    );
  });
});
