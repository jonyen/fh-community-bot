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
      channelId: "C123",
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
    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "lobby printer jammed",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
        thread_ts: "1",
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
    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "Test User",
      description: "printer is broken",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged your issue"),
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
