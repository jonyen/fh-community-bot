function parseRow(row) {
  return {
    id: row[0] || "",
    timestamp: row[1] || "",
    reporter: row[2] || "",
    description: row[3] || "",
    status: row[4] || "",
    aiSuggestion: row[5] || "",
    messageLink: row[6] || "",
    resolvedDate: row[7] || "",
  };
}

export function createSheetsService(sheetsClient, spreadsheetId) {
  async function getAllRows() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:H",
    });
    const rows = res.data.values || [];
    return rows.slice(1); // skip header
  }

  async function getAllIssues() {
    const rows = await getAllRows();
    return rows.map(parseRow);
  }

  async function getOpenIssues() {
    const all = await getAllIssues();
    return all.filter((issue) => issue.status !== "resolved");
  }

  async function getNextId() {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A",
    });
    const rows = res.data.values || [];
    const ids = rows.slice(1).map((r) => parseInt(r[0], 10)).filter(Boolean);
    return String(ids.length > 0 ? Math.max(...ids) + 1 : 1);
  }

  async function appendIssue({ reporter, description, aiSuggestion, messageLink }) {
    const id = await getNextId();
    const timestamp = new Date().toISOString();

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[id, timestamp, reporter, description, "open", aiSuggestion || "", messageLink || "", ""]],
      },
    });

    return id;
  }

  return { getAllIssues, getOpenIssues, appendIssue };
}
