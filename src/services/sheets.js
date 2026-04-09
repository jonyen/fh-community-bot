// Columns: A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED, F=IN CHARGE, G=STATUS, H=NOTES
// Data starts at row 5 (rows 1-4 are headers/metadata)
const SHEET_NAME = "Maintenance Request";
const DATA_START_ROW = 5;
const DATA_RANGE = `'${SHEET_NAME}'!A${DATA_START_ROW}:H`;

function parseRow(row, rowIndex) {
  return {
    id: String(rowIndex + DATA_START_ROW),
    date: row[0] || "",
    submitter: row[1] || "",
    description: row[2] || "",
    priority: row[3] || "",
    daysSinceFiled: row[4] || "",
    inCharge: row[5] || "",
    status: row[6] || "",
    notes: row[7] || "",
  };
}

export function createSheetsService(sheetsClient, spreadsheetId) {
  async function getAllRows() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: DATA_RANGE,
    });
    return res.data.values || [];
  }

  async function getAllIssues() {
    const rows = await getAllRows();
    return rows.map((row, i) => parseRow(row, i));
  }

  async function getOpenIssues() {
    const all = await getAllIssues();
    return all.filter((issue) => issue.status.toLowerCase() !== "resolved" && issue.status.toLowerCase() !== "completed" && issue.status.toLowerCase() !== "done");
  }

  async function getSheetId() {
    const res = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = res.data.sheets.find(
      (s) => s.properties.title === SHEET_NAME
    );
    return sheet.properties.sheetId;
  }

  async function appendIssue({ reporter, description, severity }) {
    const today = new Date().toLocaleDateString("en-US");
    const sheetId = await getSheetId();

    // Insert a blank row at row 5 (pushing existing data down)
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: DATA_START_ROW - 1, // 0-based
                endIndex: DATA_START_ROW,
              },
            },
          },
        ],
      },
    });

    // Write data into the newly inserted row
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A${DATA_START_ROW}:H${DATA_START_ROW}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[today, reporter, description, severity || "", `=TODAY()-A${DATA_START_ROW}`, "", "Need to Assign", ""]],
      },
    });

    return String(DATA_START_ROW);
  }

  async function updateIssueStatus(rowId, status) {
    const range = `'Maintenance Request'!G${rowId}`;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[status]],
      },
    });
  }

  async function appendNote(rowId, note) {
    const range = `'${SHEET_NAME}'!H${rowId}`;
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const existing = (res.data.values && res.data.values[0] && res.data.values[0][0]) || "";
    const updated = existing ? `${existing}\n${note}` : note;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[updated]],
      },
    });
  }

  return { getAllIssues, getOpenIssues, appendIssue, updateIssueStatus, appendNote };
}
