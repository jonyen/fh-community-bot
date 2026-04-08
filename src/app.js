import pkg from "@slack/bolt";
const { App } = pkg;
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { createSheetsService } from "./services/sheets.js";
import { createGroqService } from "./services/groq.js";
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

// Google Sheets client
const auth = new google.auth.GoogleAuth({
  credentials: config.googleCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsClient = google.sheets({ version: "v4", auth });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Groq client
const groqClient = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: config.groqApiKey,
});
const groqService = createGroqService(groqClient);

// Dedup service
const dedupService = createDedupService(groqService);

// Register event handler
const mentionHandler = createMentionHandler({
  sheetsService,
  groqService,
  dedupService,
  channelId: config.slackChannelId,
});
app.event("app_mention", mentionHandler);

// Schedule weekly digest
const weeklyDigest = createWeeklyDigest({
  sheetsService,
  groqService,
  slackClient: app.client,
  channelId: config.slackChannelId,
});
weeklyDigest.schedule(config.weeklyDigestCron, config.timezone);

// Start
(async () => {
  await app.start();
  console.log("Maintenance bot is running");
})();
