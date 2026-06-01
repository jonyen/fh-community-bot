import { WebClient } from "@slack/web-api";
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createMentionHandler } from "../events/mention.js";
import { createGenderMapService } from "../services/genderMap.js";
import { createGenderHandler } from "../events/gender.js";
import { createSlashRefreshHandler } from "../events/slashRefresh.js";
import { fetchWeather } from "../services/weather.js";
import { createBallHandler } from "../events/ball.js";
import { createReactionHandler } from "../events/reaction.js";

let cached;

export function getDeps() {
  if (cached) return cached;

  const config = loadConfig();

  const slack = new WebClient(config.slackBotToken);

  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret
  );
  oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
  const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
  const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

  const groqClient = new OpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: config.groqApiKey,
  });
  const groqService = createGroqService(groqClient);
  const dedupService = createDedupService(groqService);

  const handler = createMentionHandler({
    sheetsService,
    groqService,
    dedupService,
    channelIds: config.slackChannelIds,
    spreadsheetId: config.googleSheetId,
  });

  let genderHandler;
  let slashRefreshHandler;
  if (config.genderSheetId) {
    const genderMapService = createGenderMapService({
      sheetsClient,
      spreadsheetId: config.genderSheetId,
      ttlMs: config.genderCacheTtlDays * 24 * 3600 * 1000,
      tabName: config.genderSheetTab,
    });
    genderHandler = createGenderHandler({ genderMapService });
    slashRefreshHandler = createSlashRefreshHandler({ genderMapService });
  }

  const ballHandler = createBallHandler({
    fetchWeather,
    botUserId: config.slackBotUserId,
    gitSha: config.gitSha,
    runNumber: config.githubRunNumber,
  });
  const reactionHandler = createReactionHandler({ botUserId: config.slackBotUserId });

  cached = { client: slack, handler, genderHandler, slashRefreshHandler, ballHandler, reactionHandler };
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
