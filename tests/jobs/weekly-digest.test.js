import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWeeklyDigest } from "../../src/jobs/weekly-digest.js";

describe("WeeklyDigest", () => {
  let mockSheets;
  let mockOllama;
  let mockSlackClient;
  let digest;

  beforeEach(() => {
    mockSheets = {
      getOpenIssues: vi.fn(),
    };
    mockOllama = {
      generateDigest: vi.fn(),
    };
    mockSlackClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    };
    digest = createWeeklyDigest({
      sheetsService: mockSheets,
      ollamaService: mockOllama,
      slackClient: mockSlackClient,
      channelId: "C123",
    });
  });

  it("posts AI-generated summary when there are open issues", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
      { id: "2", description: "AC broken", status: "open" },
    ]);
    mockOllama.generateDigest.mockResolvedValue("*Weekly Summary:* 2 issues remain open...");

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

  it("posts fallback list when Ollama fails", async () => {
    mockSheets.getOpenIssues.mockResolvedValue([
      { id: "1", description: "Printer jammed", status: "open" },
    ]);
    mockOllama.generateDigest.mockResolvedValue(null);

    await digest.run();

    expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: expect.stringContaining("#1"),
    });
  });
});
