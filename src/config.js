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
  "GROQ_API_KEY",
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

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Load a large JSON config value (room list, resource/venue calendar maps).
//
// These are too big for CloudFormation parameters (4096 chars) and Lambda env
// vars (4 KB total), so in CI/deploy they are written to bundled files under
// `runtime-config/` and shipped inside the Lambda package. Resolution order:
//   1. `runtime-config/<fileName>` bundled in the deployment package (CI path)
//   2. the env var (local dev via .env) — raw JSON or base64
//   3. the fallback default
// A malformed value must NEVER throw — that would crash getDeps and take the
// whole worker down — so every parse failure falls back instead.
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
    let value = tryParseJson(rawEnv);
    if (value === undefined) {
      try {
        value = tryParseJson(Buffer.from(rawEnv, "base64").toString("utf8"));
      } catch {
        value = undefined;
      }
    }
    if (value !== undefined) return value;
    console.warn("[config] env JSON unparseable (raw or base64); using fallback");
  }

  return fallback;
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
    groqApiKey: process.env.GROQ_API_KEY,
    eventQueueUrl: process.env.EVENT_QUEUE_URL,
    genderSheetId: process.env.GENDER_SHEET_ID || null,
    genderSheetTab: process.env.GENDER_SHEET_TAB || "Gender Map",
    genderCacheTtlDays,
    reservationsSheetId: process.env.RESERVATIONS_SHEET_ID || null,
    onestopInfoTabs: process.env.ONESTOP_INFO_TABS
      ? process.env.ONESTOP_INFO_TABS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    onestopChannelId: process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID || null,
    // Ambient OneStop operation (the bot replying to every human message in the
    // onestop/reservations channel, incl. info Q&A) is OFF unless explicitly
    // enabled. Reservation slash commands and @-mentions are unaffected. Flip
    // ONESTOP_AMBIENT_ENABLED=true to turn ambient operation back on.
    onestopAmbientEnabled: process.env.ONESTOP_AMBIENT_ENABLED === "true",
    reservationRooms: loadJsonConfig("reservation-rooms.json", process.env.RESERVATION_ROOMS, { rooms: [], aliases: {} }),
    resourceCalendars: loadJsonConfig("resource-calendars.json", process.env.RESOURCE_CALENDARS, {}),
    venueCalendars: loadJsonConfig("venue-calendars.json", process.env.VENUE_CALENDARS, {}),
  };
}
