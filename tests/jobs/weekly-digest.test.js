import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWeeklyDigest } from "../../src/jobs/weekly-digest.js";

describe("WeeklyDigest", () => {
  let mockSheets;
  let mockGroq;
  let mockSlackClient;
  let digest;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn(),
    };
    mockGroq = {
      generateDigest: vi.fn(),
    };
    mockSlackClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    };
    digest = createWeeklyDigest({
      sheetsService: mockSheets,
      groqService: mockGroq,
      slackClient: mockSlackClient,
      channelId: "C123",
    });
  });

  it("posts AI-generated summary when there are open issues", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
      { id: "2", description: "AC broken", status: "open" },
    ]);
    mockGroq.generateDigest.mockResolvedValue("*Weekly Summary:* 2 issues remain open...");

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("Weekly Summary"),
    });
  });

  it("posts no-issues message when all resolved", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([]);

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("No outstanding issues this week"),
    });
  });

  it("posts fallback list when Groq fails", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
    ]);
    mockGroq.generateDigest.mockResolvedValue(null);

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("#1"),
    });
  });
});
