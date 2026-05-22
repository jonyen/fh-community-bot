import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";

function recentDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-US");
}

describe("MentionHandler", () => {
  let mockSheets;
  let mockGroq;
  let mockDedup;
  let handler;
  let mockSay;
  let mockClient;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("1"),
      updateIssueStatus: vi.fn().mockResolvedValue({}),
      appendNote: vi.fn().mockResolvedValue({}),
    };
    mockGroq = {
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
      isMaintenanceRequest: vi.fn().mockResolvedValue(true),
    };
    mockDedup = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    mockSay = vi.fn().mockResolvedValue({});
    mockClient = {
      users: {
        info: vi.fn().mockResolvedValue({ user: { real_name: "Test User", name: "testuser" } }),
      },
    };
    handler = createMentionHandler({
      sheetsService: mockSheets,
      groqService: mockGroq,
      dedupService: mockDedup,
      channelIds: new Set(["C123"]),
      spreadsheetId: "sheet-id",
    });
  });

  it("ignores mentions outside the configured channel", async () => {
    await handler({
      event: { channel: "C999", text: "<@U_BOT> printer broke", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).not.toHaveBeenCalled();
  });

  it("asks for a description when mention has no text", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("describe the issue"),
        thread_ts: "1",
      })
    );
  });

  it("logs a new issue and replies with confirmation + suggestion", async () => {
    // Step 1: report the issue — bot asks for severity
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("minor"),
        thread_ts: "1",
      })
    );
    expect(mockSheets.appendIssue).not.toHaveBeenCalled();

    // Step 2: user replies with severity in thread
    mockSay.mockClear();
    await handler({
      event: { channel: "C123", text: "medium", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "lobby printer jammed",
      severity: "Medium",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
        thread_ts: "1",
      })
    );
  });

  it("creates issue immediately when severity is provided inline", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed - critical", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "lobby printer jammed",
      severity: "Critical",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
        thread_ts: "1",
      })
    );
    // Should NOT have asked for severity
    expect(mockSay).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("How severe"),
      })
    );
  });

  it("appends thread replies as notes after issue is created", async () => {
    // Step 1: create issue with inline severity
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed - critical", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });
    expect(mockSheets.appendIssue).toHaveBeenCalled();

    // Step 2: follow-up reply in thread
    mockSay.mockClear();
    await handler({
      event: { channel: "C123", text: "it's the one near the front desk", user: "U1", ts: "3", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendNote).toHaveBeenCalledWith("1", "it's the one near the front desk");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("added that to the notes"),
        thread_ts: "1",
      })
    );
  });

  it("appends thread replies as notes after severity reply flow", async () => {
    // Step 1: report issue (no inline severity)
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    // Step 2: provide severity
    await handler({
      event: { channel: "C123", text: "medium", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });
    expect(mockSheets.appendIssue).toHaveBeenCalled();

    // Step 3: add extra info in thread
    mockSay.mockClear();
    await handler({
      event: { channel: "C123", text: "also it's making a weird noise", user: "U1", ts: "3", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendNote).toHaveBeenCalledWith("1", "also it's making a weird noise");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("added that to the notes"),
      })
    );
  });

  it("notifies about duplicate when one is found confidently", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("existing issue"),
        thread_ts: "1",
      })
    );
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("docs.google.com/spreadsheets/d/sheet-id"),
      })
    );
  });

  it("logs new issue with related note when dedup is uncertain", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: false });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> can't print anything", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    // Step 2: reply with severity
    mockSay.mockClear();
    await handler({
      event: { channel: "C123", text: "critical", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("might be related to issue #5"),
        thread_ts: "1",
      })
    );
  });

  it("suggests override when confident duplicate found", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("create new:"),
      })
    );
  });

  it("treats issues older than 7 days as new (skips dedup)", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(10), status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue(null);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    // findDuplicate should be called with an empty array since the issue is too old
    expect(mockDedup.findDuplicate).toHaveBeenCalledWith("printer is broken", []);

    // Reply with severity to complete issue creation
    await handler({
      event: { channel: "C123", text: "minor", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
  });

  it("bypasses duplicate check with 'create new:' prefix", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: recentDate(1), status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> create new: printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockDedup.findDuplicate).not.toHaveBeenCalled();

    // Reply with severity
    mockSay.mockClear();
    await handler({
      event: { channel: "C123", text: "critical", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "printer is broken",
      severity: "Critical",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
      })
    );
  });

  it("creates issue immediately when 'create new:' includes inline severity", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT> create new: printer is broken - critical", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "printer is broken",
      severity: "Critical",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
      })
    );
    expect(mockSay).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("How severe"),
      })
    );
  });

  it("closes an issue by ID", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close #5", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("closes an issue by description when single match", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Lobby printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
      { id: "6", description: "AC broken in room 3", submitter: "Bob", date: "4/2/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).toHaveBeenCalledWith("5", "Resolved");
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("marked as resolved"),
      })
    );
  });

  it("asks for clarification when multiple issues match close description", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed in lobby", submitter: "Alice", date: "4/1/2026", status: "Open" },
      { id: "6", description: "Printer jammed in office", submitter: "Bob", date: "4/2/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Multiple issues match"),
      })
    );
  });

  it("reports no match when close description doesn't match any issue", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> close elevator stuck", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.updateIssueStatus).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No open issue matching"),
      })
    );
  });

  it("asks for clarification when message is not a maintenance request", async () => {
    mockGroq.isMaintenanceRequest.mockResolvedValue(false);

    await handler({
      event: { channel: "C123", text: "<@U_BOT> what's for lunch today?", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not sure that's a maintenance request"),
        thread_ts: "1",
      })
    );
  });

  it("skips classification when using 'create new:' prefix", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT> create new: weird smell in kitchen", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockGroq.isMaintenanceRequest).not.toHaveBeenCalled();

    // Reply with severity
    await handler({
      event: { channel: "C123", text: "medium", user: "U1", ts: "2", thread_ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
  });

  it("handles sheets failure gracefully", async () => {
    mockSheets.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> something broke", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Couldn't log this issue"),
        thread_ts: "1",
      })
    );
  });
});
