const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_ID",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GROQ_API_KEY",
];

export function loadConfig() {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    groqApiKey: process.env.GROQ_API_KEY,
    dynamodbTable: process.env.DYNAMODB_TABLE || "",
    pinpointAppId: process.env.PINPOINT_APP_ID || "",
    pinpointNumber: process.env.PINPOINT_NUMBER || "",
    weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || "0 9 * * 1",
    timezone: process.env.TIMEZONE || "UTC",
  };
}
