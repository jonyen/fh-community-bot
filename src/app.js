import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { createSheetsService } from "./services/sheets.js";
import { createGroqService } from "./services/groq.js";
import { createDedupService } from "./services/dedup.js";
import { createMentionHandler } from "./events/mention.js";
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

// Groq client (OpenAI-compatible API)
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
  spreadsheetId: config.googleSheetId,
});
app.event("app_mention", mentionHandler);

// In threads, respond without requiring an @ mention
app.event("message", async ({ event, say, client }) => {
  if (!event.thread_ts) return;                        // only thread replies
  if (event.bot_id || event.subtype) return;           // skip bot messages
  if (/<@[A-Z0-9_]+>/.test(event.text || "")) return; // skip @mentions (handled above)
  await mentionHandler({ event, say, client });
});

// Start
(async () => {
  await app.start();
  console.log("Maintenance bot is running");
})();
