const REQUIRED = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_CHANNEL_ID",
  "GOOGLE_SHEET_ID",
  "GOOGLE_CREDENTIALS",
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
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    googleCredentials: JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString()
    ),
    groqApiKey: process.env.GROQ_API_KEY,
    weeklyDigestCron: process.env.WEEKLY_DIGEST_CRON || "0 9 * * 1",
    timezone: process.env.TIMEZONE || "UTC",
  };
}
