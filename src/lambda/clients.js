import { TaggedWebClient } from "../lib/slack-client.js";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createDriveService } from "../services/drive.js";
import { createPhotoService } from "../lib/photos.js";
import { createLlmService } from "../services/llm.js";
import { createDedupService } from "../services/dedup.js";
import { createIssueClassifierService } from "../services/issueClassifier.js";
import { createMentionHandler } from "../events/mention.js";
import { createMaintenanceFormHandler } from "../events/maintenanceForm.js";
import { createGenderMapService } from "../services/genderMap.js";
import { createGenderHandler } from "../events/gender.js";
import { createSlashRefreshHandler } from "../events/slashRefresh.js";
import { createRentManagerTwaService } from "../services/rentManagerTwa.js";
import { createCreaTicketHandler } from "../events/creaTicket.js";
import { createRoomsAdapter } from "../services/reservations/rooms.js";
import { createKitchenAdapter } from "../services/reservations/kitchen.js";
import { createRmsAdapter } from "../services/reservations/rms.js";
import { buildRmsCatalog } from "../lib/rms-catalog.js";
import { buildCatalog } from "../lib/reservation-catalog.js";
import { createLivingDigest } from "../services/livingDigest.js";
import { createReservationsHandler } from "../events/reservations.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { createAuthStore } from "../services/authStore.js";
import { createMemberGoogle } from "../services/memberGoogle.js";
import { buildConsentUrl } from "../lib/google-oauth.js";

let cached;

export function getDeps() {
  if (cached) return cached;

  const config = loadConfig();

  const slack = new TaggedWebClient(config.slackBotToken);

  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret
  );
  oauth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
  const sheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
  const sheetsService = createSheetsService(sheetsClient, config.googleSheetId);
  const driveClient = google.drive({ version: "v3", auth: oauth2Client });
  const driveService = createDriveService(driveClient, config.googleDriveFolderId);
  const photoService = createPhotoService({
    driveService,
    slackBotToken: config.slackBotToken,
  });

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const llmService = createLlmService(anthropic, config.llmModelId ? { model: config.llmModelId } : {});
  const dedupService = createDedupService(llmService);
  // Swapping the model provider means handing this a different service that
  // implements classifyIssueReport — nothing downstream of it changes.
  const issueClassifier = createIssueClassifierService(llmService);

  const handler = createMentionHandler({
    sheetsService,
    dedupService,
    issueClassifier,
    channelIds: config.slackChannelIds,
    spreadsheetId: config.googleSheetId,
    photoService,
  });

  const maintenanceFormHandler = createMaintenanceFormHandler({
    sheetsService,
    dedupService,
    photoService,
    spreadsheetId: config.googleSheetId,
  });

  let creaTicketHandler;
  if (config.creaTwa) {
    creaTicketHandler = createCreaTicketHandler({
      twaService: createRentManagerTwaService(config.creaTwa),
      sheetsService,
      ticketWriter: llmService,
      channelIds: config.slackChannelIds,
      allowedUserIds: config.creaTwa.allowedUserIds,
      slackBotToken: config.slackBotToken,
    });
  }

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

  let reservationsHandler;
  let livingDigest = null;
  const reservationAdapters = {};
  const res = config.reservations;
  if (res) {
    const sheetLink = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;
    if (res.roomsSheetId) {
      reservationAdapters.rooms = createRoomsAdapter({
        sheetsClient, spreadsheetId: res.roomsSheetId, tab: res.roomsTab, link: sheetLink(res.roomsSheetId, res.roomsGid),
      });
    }
    if (res.kitchenSheetId) {
      reservationAdapters.kitchen = createKitchenAdapter({
        sheetsClient, spreadsheetId: res.kitchenSheetId, tab: res.kitchenTab, link: sheetLink(res.kitchenSheetId, res.kitchenGid),
      });
    }
    const rmsCatalog = buildRmsCatalog(res.resourceCalendars);
    if (rmsCatalog.length) {
      const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
      reservationAdapters.rms = createRmsAdapter({ calendarClient, catalog: rmsCatalog, bookingEnabled: res.rmsBookingEnabled });
    }
    let connect = null;
    const gc = config.googleConnect;
    if (gc) {
      const authStore = createAuthStore({
        ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), kms: new KMSClient({}), tableName: gc.tableName, keyId: gc.keyId,
      });
      connect = {
        authStore,
        memberGoogle: createMemberGoogle({ authStore, clientId: gc.clientId, clientSecret: gc.clientSecret }),
        consentUrl: ({ state, loginHint }) => buildConsentUrl({ clientId: gc.clientId, redirectUri: gc.redirectUri, state, loginHint }),
      };
    }
    livingDigest = createLivingDigest({
      client: slack, adapters: reservationAdapters, channelId: res.channelId, escalationUserId: res.escalationUserId,
    });
    reservationsHandler = createReservationsHandler({
      llm: llmService,
      adapters: reservationAdapters,
      catalog: buildCatalog({ rooms: !!reservationAdapters.rooms, kitchen: !!reservationAdapters.kitchen, rms: rmsCatalog }),
      channelId: res.channelId,
      connect,
      livingDigest,
      claimBooking: connect ? connect.authStore.claimBooking : null,
    });
  }

  cached = { config, client: slack, handler, maintenanceFormHandler, creaTicketHandler, genderHandler, slashRefreshHandler, reservationsHandler, reservationAdapters, livingDigest };
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
