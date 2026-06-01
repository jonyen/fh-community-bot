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

function parseOptionalChannelList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    groqApiKey: process.env.GROQ_API_KEY,
    eventQueueUrl: process.env.EVENT_QUEUE_URL,
    genderSheetId: process.env.GENDER_SHEET_ID || null,
    genderSheetTab: process.env.GENDER_SHEET_TAB || "Gender Map",
    genderCacheTtlDays,
    slackBotUserId: process.env.SLACK_BOT_USER_ID || null,
    bballChannelIds: parseOptionalChannelList(process.env.BBALL_CHANNEL_IDS),
    gitSha: process.env.GIT_SHA || "unknown",
    githubRunNumber: process.env.GITHUB_RUN_NUMBER || "unknown",
  };
}
