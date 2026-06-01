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

  it("defaults genderSheetTab to 'Gender Map' and genderCacheTtlDays to 7 when env vars are unset", async () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.GENDER_SHEET_TAB;
    delete process.env.GENDER_CACHE_TTL_DAYS;
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetTab).toBe("Gender Map");
    expect(config.genderCacheTtlDays).toBe(7);
  });

  it("genderSheetId is null when GENDER_SHEET_ID is unset", async () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.GENDER_SHEET_ID;
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetId).toBeNull();
  });

  it("reads GENDER_SHEET_ID when set", async () => {
    Object.assign(process.env, VALID_ENV, { GENDER_SHEET_ID: "gender-sheet-xyz" });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetId).toBe("gender-sheet-xyz");
  });

  it("honors GENDER_SHEET_TAB and GENDER_CACHE_TTL_DAYS env overrides", async () => {
    Object.assign(process.env, VALID_ENV, {
      GENDER_SHEET_TAB: "Roster",
      GENDER_CACHE_TTL_DAYS: "1",
    });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.genderSheetTab).toBe("Roster");
    expect(config.genderCacheTtlDays).toBe(1);
  });

  it("exposes optional bball config with defaults", async () => {
    const prev = { ...process.env };
    Object.assign(process.env, VALID_ENV);
    process.env.SLACK_BOT_USER_ID = "UBOT";
    process.env.BBALL_CHANNEL_IDS = "C1, C2";
    delete process.env.GIT_SHA;
    delete process.env.GITHUB_RUN_NUMBER;
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.slackBotUserId).toBe("UBOT");
    expect(cfg.bballChannelIds).toEqual(["C1", "C2"]);
    expect(cfg.gitSha).toBe("unknown");
    expect(cfg.githubRunNumber).toBe("unknown");
    process.env = prev;
  });

  it("defaults bball config to empty/null when unset", async () => {
    const prev = { ...process.env };
    Object.assign(process.env, VALID_ENV);
    delete process.env.SLACK_BOT_USER_ID;
    delete process.env.BBALL_CHANNEL_IDS;
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.slackBotUserId).toBeNull();
    expect(cfg.bballChannelIds).toEqual([]);
    process.env = prev;
  });
});
