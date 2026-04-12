import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PinpointClient, SendMessagesCommand } from "@aws-sdk/client-pinpoint";
import OpenAI from "openai";
import { google } from "googleapis";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createConversationService } from "../services/conversation.js";
import { createPinpointService } from "../services/pinpoint.js";
import { createIssueProcessor } from "../core/issue-processor.js";
import { createSmsHandler } from "../handlers/sms.js";

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

// Pinpoint
const pinpointClient = new PinpointClient({});
const pinpointCommandClient = {
  sendMessages: (params) => pinpointClient.send(new SendMessagesCommand(params)),
};
const pinpointService = createPinpointService(pinpointCommandClient, config.pinpointAppId, config.pinpointNumber);

// Issue Processor
const issueProcessor = createIssueProcessor({
  sheetsService,
  groqService,
  dedupService,
  conversationService,
  spreadsheetId: config.googleSheetId,
});

// Handler
const handler = createSmsHandler({
  issueProcessor,
  conversationService,
  pinpointService,
});

export { handler };
