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
    creaTwa: loadCreaTwa(),
  };
}
