import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import { google } from "googleapis";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createConversationService } from "../services/conversation.js";
import { createIssueProcessor } from "../core/issue-processor.js";
import { createSlackHandler } from "../handlers/slack.js";

const config = loadConfig();

// DynamoDB
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const docClient = {
  get: (params) => ddbClient.send(new GetCommand(params)),
  put: (params) => ddbClient.send(new PutCommand(params)),
  delete: (params) => ddbClient.send(new DeleteCommand(params)),
};
const conversationService = createConversationService(docClient, config.dynamodbTable);

// Google Sheets
const oauth2Client = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);

// Groq
const groqClient = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: config.groqApiKey,
});
const groqService = createGroqService(groqClient);

// Dedup
const dedupService = createDedupService(groqService);

// Issue Processor
const issueProcessor = createIssueProcessor({
  sheetsService,
  groqService,
  dedupService,
  conversationService,
  spreadsheetId: config.googleSheetId,
});

// Slack client
const slackClient = new WebClient(config.slackBotToken);

// Handler
const handler = createSlackHandler({
  issueProcessor,
  conversationService,
  slackClient,
  sheetsService,
  channelId: config.slackChannelId,
  spreadsheetId: config.googleSheetId,
  signingSecret: config.slackSigningSecret,
});

export { handler };
