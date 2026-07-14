// One-time migration: add the hidden SLACK_REF column (K) to the Maintenance
// Request sheet. The bot writes the Slack thread ts of each report there and
// resolves thread -> current row through it, so row moves/sorts/deletions no
// longer break note and photo appends.
//
// MUST run before deploying code that writes A:K — appendIssue errors on a
// 10-column grid. Safe to run while old code is live (old code ignores K),
// and idempotent: re-running skips work already done.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
//   GOOGLE_SHEET_ID=... node scripts/add-slack-ref-column.mjs

import { google } from "googleapis";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SHEET_ID } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GOOGLE_SHEET_ID) {
  console.error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SHEET_ID");
  process.exit(1);
}

const SHEET_NAME = "Maintenance Request";
const HEADER_ROW = 2; // 1-based; row 2 holds the column headers

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = GOOGLE_SHEET_ID;

const meta = await sheets.spreadsheets.get({
  spreadsheetId,
  fields: "sheets.properties",
});
const props = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME)?.properties;
if (!props) {
  console.error(`Sheet tab "${SHEET_NAME}" not found`);
  process.exit(1);
}
const { sheetId, gridProperties } = props;

if (gridProperties.columnCount < 11) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { appendDimension: { sheetId, dimension: "COLUMNS", length: 11 - gridProperties.columnCount } },
      ],
    },
  });
  console.log(`expanded grid from ${gridProperties.columnCount} to 11 columns`);
} else {
  console.log("grid already has 11+ columns");
}

const header = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `'${SHEET_NAME}'!K${HEADER_ROW}`,
});
const existing = header.data.values?.[0]?.[0];
if (existing !== "SLACK_REF") {
  if (existing) {
    console.error(`K${HEADER_ROW} already contains "${existing}" — refusing to overwrite`);
    process.exit(1);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_NAME}'!K${HEADER_ROW}`,
    valueInputOption: "RAW",
    requestBody: { values: [["SLACK_REF"]] },
  });
  console.log("wrote SLACK_REF header");
} else {
  console.log("header already present");
}

await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      },
    ],
  },
});
console.log("column K hidden — migration complete");
