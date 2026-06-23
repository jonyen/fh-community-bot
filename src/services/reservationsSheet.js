// src/services/reservationsSheet.js
import { isScheduleTab } from "../lib/reservation-tabs.js";
import { parseMonthDay, parseTimeToMinutes, isAllDay } from "../lib/reservation-time.js";

const COLS = 12; // A..L

function isBlankRow(row) {
  return !row || row.every((c) => String(c || "").trim() === "");
}

export function createReservationsSheetService(sheetsClient, spreadsheetId) {
  async function getSheetIdByTitle(title) {
    const res = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    const sheet = res.data.sheets.find((s) => s.properties.title === title);
    if (!sheet) throw new Error(`tab not found: ${title}`);
    return sheet.properties.sheetId;
  }

  async function listScheduleTabs() {
    const res = await sheetsClient.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    return res.data.sheets.map((s) => s.properties.title).filter(isScheduleTab);
  }

  async function readWeekEvents(tabName) {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A1:L`,
    });
    const rows = res.data.values || [];
    const events = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (isBlankRow(row)) continue;
      const startMin = parseTimeToMinutes(row[1]);
      const endMin = parseTimeToMinutes(row[2]);
      events.push({
        rowIndex: i,
        date: parseMonthDay(row[0]),
        startMin,
        endMin,
        allDay: startMin !== null && endMin !== null && isAllDay(startMin, endMin),
        location: row[6] || "",
        what: row[5] || "",
        raw: row,
      });
    }
    return events;
  }

  async function insertRow(tabName, rowIndex0, values) {
    const sheetId = await getSheetIdByTitle(tabName);
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: rowIndex0, endIndex: rowIndex0 + 1 },
            inheritFromBefore: true,
          },
        }],
      },
    });
    const padded = Array.from({ length: COLS }, (_, i) => values[i] ?? "");
    const a1Row = rowIndex0 + 1; // 1-based
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A${a1Row}:L${a1Row}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [padded] },
    });
  }

  return { listScheduleTabs, readWeekEvents, insertRow };
}
