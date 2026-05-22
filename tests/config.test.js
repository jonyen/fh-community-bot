import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const VALID_ENV = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_IDS: "C123",
    GOOGLE_SHEET_ID: "sheet-id",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    GROQ_API_KEY: "gsk_test-key",
  };

  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads all required env vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.slackChannelIds).toEqual(new Set(["C123"]));
    expect(config.googleSheetId).toBe("sheet-id");
    expect(config.googleClientId).toBe("test-client-id");
    expect(config.googleClientSecret).toBe("test-client-secret");
    expect(config.googleRefreshToken).toBe("test-refresh-token");
    expect(config.groqApiKey).toBe("gsk_test-key");
  });

  it("parses SLACK_CHANNEL_IDS as a comma-separated set, trimming whitespace", async () => {
    Object.assign(process.env, VALID_ENV, { SLACK_CHANNEL_IDS: "C123, C456 ,C789" });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.slackChannelIds).toEqual(new Set(["C123", "C456", "C789"]));
  });

  it("reads EVENT_QUEUE_URL when set", async () => {
    Object.assign(process.env, VALID_ENV, { EVENT_QUEUE_URL: "https://sqs.example/q" });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.eventQueueUrl).toBe("https://sqs.example/q");
  });

  it("throws if a required var is missing", async () => {
    process.env = { ...originalEnv };
    delete process.env.SLACK_BOT_TOKEN;
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("Missing required environment variable");
  });
});
