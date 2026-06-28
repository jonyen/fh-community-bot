import { WebClient } from "@slack/web-api";
import { google } from "googleapis";
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { createSheetsService } from "../services/sheets.js";
import { createDriveService } from "../services/drive.js";
import { createPhotoService } from "../lib/photos.js";
import { createGroqService } from "../services/groq.js";
import { createDedupService } from "../services/dedup.js";
import { createMentionHandler } from "../events/mention.js";
import { createGenderMapService } from "../services/genderMap.js";
import { createGenderHandler } from "../events/gender.js";
import { createSlashRefreshHandler } from "../events/slashRefresh.js";
import { createReservationsSheetService } from "../services/reservationsSheet.js";
import { createCalendarService } from "../services/calendar.js";
import { createReservationsService } from "../services/reservations.js";
import { createRoomMatcher } from "../lib/reservation-rooms.js";
import { createReservationHandler } from "../events/reservations.js";
import { createOneStopInfoService } from "../services/onestopInfo.js";

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
  const driveClient = google.drive({ version: "v3", auth: oauth2Client });
  const driveService = createDriveService(driveClient, config.googleDriveFolderId);
  const photoService = createPhotoService({
    driveService,
    slackBotToken: config.slackBotToken,
  });

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
    photoService,
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

  let reservationHandler;
  if (config.reservationsSheetId) {
    const reservationsSheetClient = google.sheets({ version: "v4", auth: oauth2Client });
    const reservationsSheetService = createReservationsSheetService(
      reservationsSheetClient,
      config.reservationsSheetId
    );
    const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
    const calendarService = createCalendarService(calendarClient);
    const roomMatcher = createRoomMatcher(
      config.reservationRooms.rooms || [],
      config.reservationRooms.aliases || {}
    );
    const reservationsService = createReservationsService({
      sheetService: reservationsSheetService,
      calendarService,
      roomMatcher,
      resourceCalendars: config.resourceCalendars,
      now: () => new Date(),
    });
    const onestopInfoService = createOneStopInfoService({
      sheetsClient: google.sheets({ version: "v4", auth: oauth2Client }),
      sheetId: config.reservationsSheetId,
      tabs: config.onestopInfoTabs, // undefined → service allowlist default
      now: () => new Date(),
    });
    reservationHandler = createReservationHandler({
      reservationsService,
      groqService,
      onestopInfoService,
      now: () => new Date(),
    });
  }

  // Ambient onestop-channel routing is gated by the toggle: when disabled, the
  // channel id is withheld so dispatch never routes plain channel messages to
  // the handler (slash commands and @-mentions still work).
  const onestopChannelId = config.onestopAmbientEnabled ? config.onestopChannelId : null;
  cached = { client: slack, handler, genderHandler, slashRefreshHandler, reservationHandler, onestopChannelId };
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
