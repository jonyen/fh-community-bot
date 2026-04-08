import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";

describe("MentionHandler", () => {
  let mockSheets;
  let mockGroq;
  let mockDedup;
  let handler;
  let mockSay;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("1"),
    };
    mockGroq = {
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
    };
    mockDedup = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    mockSay = vi.fn().mockResolvedValue({});
    handler = createMentionHandler({
      sheetsService: mockSheets,
      groqService: mockGroq,
      dedupService: mockDedup,
      channelId: "C123",
    });
  });

  it("ignores mentions outside the configured channel", async () => {
    await handler({
      event: { channel: "C999", text: "<@U_BOT> printer broke", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).not.toHaveBeenCalled();
  });

  it("asks for a description when mention has no text", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("describe the issue"),
        thread_ts: "1",
      })
    );
  });

  it("logs a new issue and replies with confirmation + suggestion", async () => {
    const mockPermalink = vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> lobby printer jammed", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: mockPermalink } },
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "U1",
      description: "lobby printer jammed",
      aiSuggestion: "Try restarting it.",
      messageLink: "https://slack.com/msg",
    });
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Logged as issue #1"),
        thread_ts: "1",
      })
    );
  });

  it("notifies about duplicate when one is found confidently", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", reporter: "U2", timestamp: "2026-04-01", status: "open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("already been logged"),
        thread_ts: "1",
      })
    );
  });

  it("logs new issue with related note when dedup is uncertain", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", reporter: "U2", timestamp: "2026-04-01", status: "open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: false });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> can't print anything", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSheets.appendIssue).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("might be related to issue #5"),
        thread_ts: "1",
      })
    );
  });

  it("handles sheets failure gracefully", async () => {
    mockSheets.getOpenIssues.mockRejectedValue(new Error("Sheets down"));

    await handler({
      event: { channel: "C123", text: "<@U_BOT> something broke", user: "U1", ts: "1" },
      say: mockSay,
      client: { chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.com/msg" }) } },
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Couldn't log this issue"),
        thread_ts: "1",
      })
    );
  });
});
