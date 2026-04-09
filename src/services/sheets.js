// Columns: A=DATE, B=SUBMITTER, C=ISSUE, D=PRIORITY, E=DAYS SINCE FILED, F=IN CHARGE, G=STATUS, H=NOTES
// Data starts at row 5 (rows 1-4 are headers/metadata)
const DATA_START_ROW = 5;
const DATA_RANGE = `'Maintenance Request'!A${DATA_START_ROW}:H`;

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
    return all.filter((issue) => issue.status.toLowerCase() !== "resolved" && issue.status.toLowerCase() !== "completed");
  }

  async function appendIssue({ reporter, description }) {
    const today = new Date().toLocaleDateString("en-US");

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: DATA_RANGE,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[today, reporter, description, "", "", "", "Open", ""]],
      },
    });

    // Return the new row number as the ID
    const rows = await getAllRows();
    return String(rows.length + DATA_START_ROW - 1);
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

  return { getAllIssues, getOpenIssues, appendIssue, updateIssueStatus };
}
