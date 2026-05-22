const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
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

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

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
  };
}
