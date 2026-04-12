import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackHandler } from "../../src/handlers/slack.js";

function makeSlackEvent(slackEvent) {
  return {
    body: JSON.stringify({ type: "event_callback", event: slackEvent }),
    headers: {
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
    },
  };
}

describe("createSlackHandler", () => {
  let issueProcessor;
  let conversationService;
  let slackClient;
  let sheetsService;
  let handler;
  const channelId = "C123CHANNEL";
  const spreadsheetId = "spreadsheet-abc";

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
    slackClient = {
      reactions: { add: vi.fn().mockResolvedValue({}) },
      chat: { postMessage: vi.fn().mockResolvedValue({}) },
      users: { info: vi.fn().mockResolvedValue({ user: { real_name: "Alice Smith", name: "alice" } }) },
    };
    sheetsService = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("42"),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
      appendNote: vi.fn().mockResolvedValue({}),
    };

    handler = createSlackHandler({
      issueProcessor,
      conversationService,
      slackClient,
      sheetsService,
      channelId,
      spreadsheetId,
      signingSecret: "",
    });
  });

  it("returns challenge for URL verification", async () => {
    const event = {
      body: JSON.stringify({ type: "url_verification", challenge: "test-challenge-123" }),
      headers: {},
    };
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(result.body).challenge).toBe("test-challenge-123");
  });

  it("ignores events outside configured channel", async () => {
    const event = makeSlackEvent({
      type: "app_mention",
      channel: "C999OTHER",
      user: "U123",
      text: "<@BOT> printer broken",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(issueProcessor.processNewReport).not.toHaveBeenCalled();
    expect(slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it("processes app_mention as new issue report", async () => {
    issueProcessor.processNewReport.mockResolvedValue({ action: "awaiting_severity" });

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> the lobby printer is jammed",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(issueProcessor.processNewReport).toHaveBeenCalledWith({
      description: "the lobby printer is jammed",
      reporterName: "Alice Smith",
      conversationKey: "SLACK#1234567890.123456",
      forceCreate: false,
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("How severe"),
      })
    );
  });

  it("processes severity reply in thread", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "awaiting_severity" });
    issueProcessor.processSeverityReply.mockResolvedValue({
      action: "issue_created",
      severity: "Minor",
      suggestion: "Try turning it off and on again.",
      issueRowId: "42",
    });

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> minor",
      thread_ts: "1234567890.123456",
      ts: "1234567891.000001",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(issueProcessor.processSeverityReply).toHaveBeenCalledWith({
      conversationKey: "SLACK#1234567890.123456",
      severity: "minor",
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
      })
    );
  });

  it("lists open issues", async () => {
    const now = new Date();
    sheetsService.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Broken window", submitter: "Bob", date: now.toISOString(), status: "Open" },
      { id: "2", description: "Leaky faucet", submitter: "Carol", date: now.toISOString(), status: "In Progress" },
    ]);

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> list open issues",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Broken window"),
      })
    );
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Leaky faucet"),
      })
    );
    expect(issueProcessor.processNewReport).not.toHaveBeenCalled();
  });

  it("closes issue by ID", async () => {
    sheetsService.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Broken door", submitter: "Bob", date: "2026-04-10", status: "Open" },
    ]);

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> close #5",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(sheetsService.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("closes issue by description (single match)", async () => {
    sheetsService.getOpenIssues.mockResolvedValue([
      { id: "3", description: "Broken lobby printer", submitter: "Bob", date: "2026-04-10", status: "Open" },
      { id: "4", description: "Leaky faucet kitchen", submitter: "Carol", date: "2026-04-09", status: "Open" },
    ]);

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> close broken lobby printer",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(sheetsService.updateIssueStatus).toHaveBeenCalledWith("3", "Resolved");
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("shows multiple matches for ambiguous close", async () => {
    sheetsService.getOpenIssues.mockResolvedValue([
      { id: "3", description: "Broken printer floor 1", submitter: "Bob", date: "2026-04-10", status: "Open" },
      { id: "4", description: "Broken printer floor 2", submitter: "Carol", date: "2026-04-09", status: "Open" },
    ]);

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> close broken printer",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(sheetsService.updateIssueStatus).not.toHaveBeenCalled();
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Multiple issues match"),
      })
    );
  });

  it("appends thread reply as note when issue exists", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "issue_created" });
    issueProcessor.processFollowUp.mockResolvedValue({ action: "note_added" });

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> it's the one near the front desk",
      thread_ts: "1234567890.123456",
      ts: "1234567891.000002",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(issueProcessor.processFollowUp).toHaveBeenCalledWith({
      conversationKey: "SLACK#1234567890.123456",
      text: "it's the one near the front desk",
    });
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("added that to the notes"),
      })
    );
  });

  it("returns not_maintenance reply", async () => {
    issueProcessor.processNewReport.mockResolvedValue({ action: "not_maintenance" });

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> what's for lunch?",
      ts: "1234567890.123456",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not sure that's a maintenance request"),
      })
    );
  });

  it("handles CC for medium/critical severity", async () => {
    conversationService.getConversation.mockResolvedValue({ state: "awaiting_severity" });
    issueProcessor.processSeverityReply.mockResolvedValue({
      action: "issue_created",
      severity: "Critical",
      suggestion: "Call an electrician immediately.",
      issueRowId: "10",
    });

    const event = makeSlackEvent({
      type: "app_mention",
      channel: channelId,
      user: "U123",
      text: "<@BOT> critical",
      thread_ts: "1234567890.123456",
      ts: "1234567891.000003",
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("<@U0000000000>"),
      })
    );
  });
});
