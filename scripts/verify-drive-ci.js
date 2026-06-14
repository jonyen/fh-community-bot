/**
 * Diagnostic: confirm the bot's Google token can actually upload into the
 * configured Drive folder, exercising the exact production path in
 * src/services/drive.js (create file with parent → share anyone-reader →
 * lh3 image URL), then deletes the test file.
 *
 * Run via the verify-drive GitHub workflow, where the credentials are readable.
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *      GOOGLE_DRIVE_FOLDER_ID (optional — empty means Drive root).
 */

import { Readable } from "node:stream";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

if (!clientId || !clientSecret || !refreshToken) {
  console.error(
    "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN."
  );
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });
const drive = google.drive({ version: "v3", auth });

console.log(`Target folder: ${folderId || "(Drive root)"}\n`);

let fileId;
try {
  const res = await drive.files.create({
    requestBody: {
      name: "fh-community-bot drive write check",
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: {
      mimeType: "text/plain",
      body: Readable.from(Buffer.from("fh-community-bot drive write check")),
    },
    fields: "id, parents, webViewLink",
  });
  fileId = res.data.id;
  console.log(`OK  created file ${fileId} (parents: ${JSON.stringify(res.data.parents)})`);

  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });
  console.log("OK  set anyone-with-link reader permission");
  console.log(`OK  thumbnail URL would be https://lh3.googleusercontent.com/d/${fileId}`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (/File not found|insufficient|not found/i.test(err.message)) {
    console.error(
      "\nThis looks like the drive.file scope being unable to write into a folder\n" +
        "the app did not create. Options: (a) let the bot upload to Drive root\n" +
        "(unset GOOGLE_DRIVE_FOLDER_ID), or (b) re-issue the token with the full\n" +
        "https://www.googleapis.com/auth/drive scope."
    );
  }
  process.exit(1);
}

try {
  await drive.files.delete({ fileId });
  console.log("OK  cleaned up test file");
} catch (err) {
  console.error(`WARN  could not delete test file ${fileId}: ${err.message}`);
}

console.log(
  `\nSUCCESS — uploads into ${folderId || "Drive root"} work with the current token.`
);
