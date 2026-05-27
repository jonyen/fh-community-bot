import "dotenv/config";
import { google } from "googleapis";
import { WebClient } from "@slack/web-api";

const SHEET_ID = "1ssY0G6uJ2N5Zr63vIA3h9n4GddgFpWWuYfHsfXZHVFs";
const TAB = "Gender Map";
const EMAIL_COL_IDX = 2;
const HEADER = "slack_id";

async function main() {
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const sheets = google.sheets({ version: "v4", auth: oauth });
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:C`,
  });
  const rows = res.data.values || [];
  console.log(`[sheet] ${rows.length} data rows`);

  const results = [];
  const misses = [];
  let i = 0;
  for (const row of rows) {
    i += 1;
    const email = (row[EMAIL_COL_IDX] || "").trim();
    if (!email) {
      results.push("");
      misses.push({ row: i + 1, reason: "no email" });
      continue;
    }
    try {
      const r = await slack.users.lookupByEmail({ email });
      results.push(r.user.id);
      console.log(`[${i}/${rows.length}] ${email} -> ${r.user.id}`);
    } catch (err) {
      const code = err.data?.error || err.message;
      results.push("");
      misses.push({ row: i + 1, email, reason: code });
      console.log(`[${i}/${rows.length}] ${email} -> MISS (${code})`);
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!D1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[HEADER]] },
  });

  const lastRow = rows.length + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!D2:D${lastRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: results.map((v) => [v]) },
  });

  const found = results.filter(Boolean).length;
  console.log(`\n[summary] found=${found} missed=${misses.length} total=${rows.length}`);
  if (misses.length > 0) {
    console.log(`[misses]`);
    for (const m of misses) {
      console.log(`  row ${m.row}: ${m.email || "<blank>"} - ${m.reason}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.response?.data?.error) console.error(JSON.stringify(err.response.data.error, null, 2));
  process.exit(1);
});
