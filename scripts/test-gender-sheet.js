import "dotenv/config";
import { google } from "googleapis";
import { createGenderMapService } from "../src/services/genderMap.js";

const SHEET_ID = "1ssY0G6uJ2N5Zr63vIA3h9n4GddgFpWWuYfHsfXZHVFs";
const TAB = process.env.GENDER_SHEET_TAB || "Gender Map";

async function main() {
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const sheetsClient = google.sheets({ version: "v4", auth: oauth });

  console.log(`[sheet] spreadsheetId=${SHEET_ID}`);
  console.log(`[sheet] tab=${TAB}`);

  try {
    const meta = await sheetsClient.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: "properties.title,sheets.properties(title,sheetId)",
    });
    console.log(`[meta] title=${meta.data.properties.title}`);
    console.log(
      `[meta] tabs=${meta.data.sheets.map((s) => s.properties.title).join(", ")}`
    );
    const hasTab = meta.data.sheets.some(
      (s) => s.properties.title === TAB
    );
    if (!hasTab) {
      console.error(`[FAIL] tab "${TAB}" not found in spreadsheet`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`[FAIL] spreadsheets.get: ${err.message}`);
    if (err.response?.data?.error) {
      console.error(JSON.stringify(err.response.data.error, null, 2));
    }
    process.exit(1);
  }

  const service = createGenderMapService({
    sheetsClient,
    spreadsheetId: SHEET_ID,
    ttlMs: 60 * 1000,
    tabName: TAB,
  });

  try {
    const map = await service.getMap();
    const entries = Object.entries(map);
    console.log(`[map] valid entries=${entries.length}`);
    const males = entries.filter(([, g]) => g === "male").length;
    const females = entries.filter(([, g]) => g === "female").length;
    console.log(`[map] male=${males} female=${females}`);
    if (entries.length > 0) {
      const sample = entries.slice(0, 3).map(([u, g]) => `${u}:${g}`).join(", ");
      console.log(`[map] sample=${sample}`);
    }
    console.log("[OK] sheet reachable + parsed");
  } catch (err) {
    console.error(`[FAIL] getMap: ${err.message}`);
    if (err.response?.data?.error) {
      console.error(JSON.stringify(err.response.data.error, null, 2));
    }
    process.exit(1);
  }
}

main();
