import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

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

  it("googleDriveFolderId is null when unset and reads it when set", async () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().googleDriveFolderId).toBeNull();

    process.env.GOOGLE_DRIVE_FOLDER_ID = "FOLDER1";
    expect(loadConfig().googleDriveFolderId).toBe("FOLDER1");
  });

});

describe("loadConfig — CREA tickets", () => {
  const CREA_KEYS = ["CREA_TICKETS_ENABLED", "CREA_TWA_USERNAME", "CREA_TWA_PASSWORD", "CREA_TWA_PHONE", "CREA_TICKET_USER_IDS"];
  const saved = {};
  beforeEach(() => {
    for (const k of [...CREA_KEYS, "SLACK_BOT_TOKEN", "SLACK_CHANNEL_IDS", "GOOGLE_SHEET_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GROQ_API_KEY"]) saved[k] = process.env[k];
    Object.assign(process.env, {
      SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_IDS: "C1", GOOGLE_SHEET_ID: "s", GOOGLE_CLIENT_ID: "c",
      GOOGLE_CLIENT_SECRET: "c", GOOGLE_REFRESH_TOKEN: "r", GROQ_API_KEY: "g",
      CREA_TWA_USERNAME: "u", CREA_TWA_PASSWORD: "p", CREA_TWA_PHONE: "555", CREA_TICKET_USER_IDS: "U1, U2",
    });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is off unless CREA_TICKETS_ENABLED is true, even with a login", () => {
    delete process.env.CREA_TICKETS_ENABLED;
    expect(loadConfig().creaTwa).toBeNull();
    process.env.CREA_TICKETS_ENABLED = "false";
    expect(loadConfig().creaTwa).toBeNull();
  });

  it("is on when enabled and the login is set", () => {
    process.env.CREA_TICKETS_ENABLED = "true";
    const { creaTwa } = loadConfig();
    expect(creaTwa.username).toBe("u");
    expect([...creaTwa.allowedUserIds]).toEqual(["U1", "U2"]);
  });
});
