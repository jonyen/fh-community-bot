import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const VALID_ENV = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret-test",
    SLACK_CHANNEL_ID: "C123",
    GOOGLE_SHEET_ID: "sheet-id",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    GROQ_API_KEY: "gsk_test-key",
    DYNAMODB_TABLE: "my-table",
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
    expect(config.slackSigningSecret).toBe("signing-secret-test");
    expect(config.slackChannelId).toBe("C123");
    expect(config.googleSheetId).toBe("sheet-id");
    expect(config.googleClientId).toBe("test-client-id");
    expect(config.googleClientSecret).toBe("test-client-secret");
    expect(config.googleRefreshToken).toBe("test-refresh-token");
    expect(config.groqApiKey).toBe("gsk_test-key");
  });

  it("uses defaults for optional vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.weeklyDigestCron).toBe("0 9 * * 1");
    expect(config.timezone).toBe("UTC");
  });

  it("throws if a required var is missing", async () => {
    process.env = { ...originalEnv };
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("Missing required environment variable");
  });

  it("loads new AWS env vars correctly", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      DYNAMODB_TABLE: "test-table",
      PINPOINT_APP_ID: "pinpoint-app-123",
      PINPOINT_NUMBER: "+15005550001",
    });
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.slackSigningSecret).toBe("signing-secret-test");
    expect(config.dynamodbTable).toBe("test-table");
    expect(config.pinpointAppId).toBe("pinpoint-app-123");
    expect(config.pinpointNumber).toBe("+15005550001");
  });

  it("optional AWS vars default to empty string when not set", async () => {
    const envWithoutOptional = { ...VALID_ENV };
    delete envWithoutOptional.DYNAMODB_TABLE;
    Object.assign(process.env, envWithoutOptional);
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.dynamodbTable).toBe("");
    expect(config.pinpointAppId).toBe("");
    expect(config.pinpointNumber).toBe("");
    expect(config.slackSigningSecret).toBe("signing-secret-test");
  });

  it("SLACK_APP_TOKEN is no longer required", async () => {
    const envWithoutAppToken = { ...VALID_ENV };
    delete envWithoutAppToken.SLACK_APP_TOKEN;
    Object.assign(process.env, envWithoutAppToken);
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).not.toThrow();
  });
});
