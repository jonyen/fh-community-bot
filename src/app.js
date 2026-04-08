import pkg from "@slack/bolt";
const { App } = pkg;
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { createSheetsService } from "./services/sheets.js";
import { createOllamaService } from "./services/ollama.js";
import { createDedupService } from "./services/dedup.js";
import { createMentionHandler } from "./events/mention.js";
import { createWeeklyDigest } from "./jobs/weekly-digest.js";

const config = loadConfig();

// Slack Bolt app
const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

// Google Sheets client (OAuth2)
const oauth2Client = new google.auth.OAuth2(
  config.googleClientId,
  config.googleClientSecret
);
oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Ollama client (OpenAI-compatible local API)
const ollamaClient = new OpenAI({
  baseURL: config.ollamaBaseUrl,
  apiKey: "ollama",
});
const ollamaService = createOllamaService(ollamaClient);

// Dedup service
const dedupService = createDedupService(ollamaService);

// Register event handler
const mentionHandler = createMentionHandler({
  sheetsService,
  ollamaService,
  dedupService,
  channelId: config.slackChannelId,
});
app.event("app_mention", mentionHandler);

// Schedule weekly digest
const weeklyDigest = createWeeklyDigest({
  sheetsService,
  ollamaService,
  slackClient: app.client,
  channelId: config.slackChannelId,
});
weeklyDigest.schedule(config.weeklyDigestCron, config.timezone);

// Start
(async () => {
  await app.start();
  console.log("Maintenance bot is running");
})();
