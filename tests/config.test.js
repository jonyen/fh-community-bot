import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const RUNTIME_CONFIG_DIR = fileURLToPath(new URL("../runtime-config", import.meta.url));

describe("loadConfig reservations vars", () => {
  const base = {
    SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_IDS: "C1", GOOGLE_SHEET_ID: "s",
    GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "cs", GOOGLE_REFRESH_TOKEN: "r", GROQ_API_KEY: "g",
  };
  let saved;
  beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, base); });
  afterEach(() => { process.env = saved; });

  it("defaults reservations config to null/empty when unset", () => {
    delete process.env.RESERVATIONS_SHEET_ID;
    const cfg = loadConfig();
    expect(cfg.reservationsSheetId).toBeNull();
  });

  it("parses room and calendar JSON when set", () => {
    process.env.RESERVATIONS_SHEET_ID = "RS1";
    process.env.RESERVATION_ROOMS = JSON.stringify({ rooms: ["FH MPR"], aliases: { mpr: "FH MPR" } });
    process.env.RESOURCE_CALENDARS = JSON.stringify({ projector: "cal@x" });
    const cfg = loadConfig();
    expect(cfg.reservationsSheetId).toBe("RS1");
    expect(cfg.reservationRooms.rooms).toEqual(["FH MPR"]);
    expect(cfg.resourceCalendars).toEqual({ projector: "cal@x" });
  });

  it("parses base64-encoded JSON (deploy delivers it base64 to survive SAM)", () => {
    const rooms = { rooms: ["FH MPR", "Childcare Room"], aliases: { mpr: "FH MPR" } };
    process.env.RESERVATION_ROOMS = Buffer.from(JSON.stringify(rooms)).toString("base64");
    process.env.RESOURCE_CALENDARS = Buffer.from(JSON.stringify({ "DMV Accessories-Popcorn Machine": "c_1@x" })).toString("base64");
    const cfg = loadConfig();
    expect(cfg.reservationRooms.rooms).toEqual(["FH MPR", "Childcare Room"]);
    expect(cfg.resourceCalendars).toEqual({ "DMV Accessories-Popcorn Machine": "c_1@x" });
  });

  it("falls back to defaults (no throw) when a JSON var is malformed", () => {
    process.env.RESERVATION_ROOMS = "{"; // truncated — must NOT crash loadConfig/getDeps
    process.env.VENUE_CALENDARS = "not json at all";
    const cfg = loadConfig();
    expect(cfg.reservationRooms).toEqual({ rooms: [], aliases: {} });
    expect(cfg.venueCalendars).toEqual({});
  });

  it("reads a bundled runtime-config file in preference to the env var", () => {
    const file = `${RUNTIME_CONFIG_DIR}/resource-calendars.json`;
    const createdDir = !existsSync(RUNTIME_CONFIG_DIR);
    mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ "DMV Accessories-Popcorn Machine": "c_file@x" }));
    process.env.RESOURCE_CALENDARS = JSON.stringify({ "ignored": "c_env@x" }); // file wins
    try {
      const cfg = loadConfig();
      expect(cfg.resourceCalendars).toEqual({ "DMV Accessories-Popcorn Machine": "c_file@x" });
    } finally {
      rmSync(file, { force: true });
      if (createdDir) rmSync(RUNTIME_CONFIG_DIR, { recursive: true, force: true });
    }
  });
});

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

  it("loads onestopChannelId from ONESTOP_CHANNEL_ID, falling back to RESERVATIONS_CHANNEL_ID", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.ONESTOP_CHANNEL_ID;
    delete process.env.RESERVATIONS_CHANNEL_ID;
    expect(loadConfig().onestopChannelId).toBeNull();
    process.env.RESERVATIONS_CHANNEL_ID = "Cold";
    expect(loadConfig().onestopChannelId).toBe("Cold"); // fallback
    process.env.ONESTOP_CHANNEL_ID = "Conestop";
    expect(loadConfig().onestopChannelId).toBe("Conestop"); // new var wins
  });

  it("defaults onestopAmbientEnabled to false, true only when ONESTOP_AMBIENT_ENABLED=true", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.ONESTOP_AMBIENT_ENABLED;
    expect(loadConfig().onestopAmbientEnabled).toBe(false);
    process.env.ONESTOP_AMBIENT_ENABLED = "false";
    expect(loadConfig().onestopAmbientEnabled).toBe(false);
    process.env.ONESTOP_AMBIENT_ENABLED = "true";
    expect(loadConfig().onestopAmbientEnabled).toBe(true);
  });

  it("parses ONESTOP_INFO_TABS into a trimmed array (undefined when unset)", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.ONESTOP_INFO_TABS;
    expect(loadConfig().onestopInfoTabs).toBeUndefined();
    process.env.ONESTOP_INFO_TABS = "BULLETIN, Links ,IH";
    expect(loadConfig().onestopInfoTabs).toEqual(["BULLETIN", "Links", "IH"]);
  });
});
