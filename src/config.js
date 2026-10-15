import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
// SLACK_SIGNING_SECRET is required only by the receiver Lambda, which reads
// process.env directly and never calls loadConfig(). The worker (which does
// call loadConfig via clients.js) has no use for it.
const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_IDS",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

function parseChannelIds(raw) {
  const ids = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("SLACK_CHANNEL_IDS must contain at least one channel ID");
  }
  return new Set(ids);
}

// The CREA portal integration is on only when CREA_TICKETS_ENABLED is "true"
// and login and the phone number the portal requires are all set; otherwise
// ticket reactions are ignored.
function loadCreaTwa() {
  const { CREA_TICKETS_ENABLED, CREA_TWA_USERNAME, CREA_TWA_PASSWORD, CREA_TWA_PHONE } = process.env;
  if ((CREA_TICKETS_ENABLED || "").toLowerCase() !== "true") return null;
  if (!CREA_TWA_USERNAME || !CREA_TWA_PASSWORD || !CREA_TWA_PHONE) return null;
  return {
    // Slack user IDs allowed to file tickets. Empty means nobody can.
    allowedUserIds: new Set(
      (process.env.CREA_TICKET_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
    ),
    baseUrl: process.env.CREA_TWA_URL || "https://creallc.twa.rentmanager.com",
    username: CREA_TWA_USERNAME,
    password: CREA_TWA_PASSWORD,
    phone: CREA_TWA_PHONE,
    allowEntry: (process.env.CREA_TWA_ALLOW_ENTRY || "").toLowerCase() === "true",
  };
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// RESOURCE_CALENDARS is ~11 KB: too big for a CloudFormation parameter (4096
// chars) or Lambda env vars (4 KB total). The deploy workflow writes it to
// runtime-config/ before `sam build`, so it ships inside the package. Order:
// bundled file, then the env var (local .env, raw JSON or base64), then the
// fallback. A bad value must never throw, or getDeps crashes and the whole
// worker dies on every event.
function loadJsonConfig(fileName, rawEnv, fallback) {
  try {
    const path = fileURLToPath(new URL(`../runtime-config/${fileName}`, import.meta.url));
    if (existsSync(path)) {
      const parsed = tryParseJson(readFileSync(path, "utf8"));
      if (parsed !== undefined) return parsed;
      console.warn(`[config] ${fileName} present but unparseable; trying env/fallback`);
    }
  } catch (err) {
    console.warn(`[config] reading ${fileName} failed: ${err.message}`);
  }
  if (rawEnv) {
    const value = tryParseJson(rawEnv) ?? tryParseJson(Buffer.from(rawEnv, "base64").toString("utf8"));
    if (value !== undefined) return value;
    console.warn("[config] env JSON unparseable (raw or base64); using fallback");
  }
  return fallback;
}

// #reservations is on only when its channel is set. Each backend is on only
// when its own id (or calendar map) is set.
function loadReservations() {
  const channelId = process.env.RESERVATIONS_CHANNEL_ID;
  if (!channelId) return null;
  const calendars = loadJsonConfig("resource-calendars.json", process.env.RESOURCE_CALENDARS, {});
  return {
    channelId,
    roomsSheetId: process.env.ROOM_REQUESTS_SHEET_ID || null,
    roomsTab: process.env.ROOM_REQUESTS_TAB || "Upcoming Room Requests",
    roomsGid: process.env.ROOM_REQUESTS_GID || "1580896517",
    kitchenSheetId: process.env.KITCHEN_SHEET_ID || null,
    kitchenTab: process.env.KITCHEN_TAB || "FH-Kitchen-RSVP",
    kitchenGid: process.env.KITCHEN_GID || "2109987656",
    resourceCalendars: calendars && typeof calendars === "object" && !Array.isArray(calendars) ? calendars : {},
    rmsBookingEnabled: (process.env.RMS_BOOKING_ENABLED || "true").toLowerCase() !== "false",
    escalationUserId: process.env.ESCALATION_USER_ID || null,
  };
}

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const ttlRaw = process.env.GENDER_CACHE_TTL_DAYS;
  const genderCacheTtlDays = ttlRaw ? Number(ttlRaw) : 7;

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackChannelIds: parseChannelIds(process.env.SLACK_CHANNEL_IDS),
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
    llmModelId: process.env.LLM_MODEL_ID || null,
    eventQueueUrl: process.env.EVENT_QUEUE_URL,
    genderSheetId: process.env.GENDER_SHEET_ID || null,
    genderSheetTab: process.env.GENDER_SHEET_TAB || "Gender Map",
    genderCacheTtlDays,
    creaTwa: loadCreaTwa(),
    reservations: loadReservations(),
  };
}
