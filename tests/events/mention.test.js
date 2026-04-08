import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMentionHandler } from "../../src/events/mention.js";

describe("MentionHandler", () => {
  let mockSheets;
  let mockOllama;
  let mockDedup;
  let handler;
  let mockSay;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn().mockResolvedValue([]),
      appendIssue: vi.fn().mockResolvedValue("1"),
    };
    mockOllama = {
      suggestFix: vi.fn().mockResolvedValue("Try restarting it."),
    };
    mockDedup = {
      findDuplicate: vi.fn().mockResolvedValue(null),
    };
    mockSay = vi.fn().mockResolvedValue({});
    handler = createMentionHandler({
      sheetsService: mockSheets,
      ollamaService: mockOllama,
      dedupService: mockDedup,
      channelId: "C123",
    });
  });

  it("ignores mentions outside the configured channel", async () => {
    await handler({
      event: { channel: "C999", text: "<@U_BOT> printer broke", user: "U1", ts: "1" },
      say: mockSay,
      client: {},
    });

    expect(mockSay).not.toHaveBeenCalled();
  });

  it("asks for a description when mention has no text", async () => {
    await handler({
      event: { channel: "C123", text: "<@U_BOT>", user: "U1", ts: "1" },
      say: mockSay,
      client: {},
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
      client: {},
    });

    expect(mockSheets.appendIssue).toHaveBeenCalledWith({
      reporter: "U1",
      description: "lobby printer jammed",
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
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: true });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> printer is broken", user: "U1", ts: "1" },
      say: mockSay,
      client: {},
    });

    expect(mockSheets.appendIssue).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("existing issue"),
        thread_ts: "1",
      })
    );
  });

  it("logs new issue with related note when dedup is uncertain", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "5", description: "Printer jammed", submitter: "Alice", date: "4/1/2026", status: "Open" },
    ]);
    mockDedup.findDuplicate.mockResolvedValue({ id: "5", confident: false });

    await handler({
      event: { channel: "C123", text: "<@U_BOT> can't print anything", user: "U1", ts: "1" },
      say: mockSay,
      client: {},
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
      client: {},
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Couldn't log this issue"),
        thread_ts: "1",
      })
    );
  });
});
