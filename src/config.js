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

// Parse a JSON-valued env var that may arrive either as raw JSON (local .env)
// or base64-encoded JSON (CI/deploy encodes it so SAM's --parameter-overrides
// shorthand, which splits values on spaces, can't mangle room names like
// "FH MPR"). A malformed value must NEVER throw — that would crash getDeps and
// take the whole worker down — so fall back to the default instead.
function parseJsonEnv(raw, fallback) {
  if (!raw) return fallback;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let value = tryParse(raw);
  if (value === undefined) {
    let decoded;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      decoded = "";
    }
    value = tryParse(decoded);
  }
  if (value === undefined) {
    console.warn("[config] could not parse JSON env var (raw or base64); using fallback");
    return fallback;
  }
  return value;
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
    reservationRooms: parseJsonEnv(process.env.RESERVATION_ROOMS, { rooms: [], aliases: {} }),
    resourceCalendars: parseJsonEnv(process.env.RESOURCE_CALENDARS, {}),
    venueCalendars: parseJsonEnv(process.env.VENUE_CALENDARS, {}),
  };
}
