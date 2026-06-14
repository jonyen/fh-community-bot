/**
 * One-time script to get a Google OAuth2 refresh token.
 *
 * Prerequisites:
 *   1. Create an OAuth 2.0 Client ID (Desktop app) in Google Cloud Console
 *   2. Download the client JSON and note the client_id and client_secret
 *
 * Usage:
 *   node scripts/get-google-token.js <client_id> <client_secret>
 *
 * This will open a browser for you to sign in and grant Sheets + Drive access.
 * The refresh token will be printed to the console — paste it into your .env.
 */

import http from "node:http";
import { google } from "googleapis";

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error(
    "Usage: node scripts/get-google-token.js <client_id> <client_secret>"
  );
  process.exit(1);
}

const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
  ],
});

// Start a temporary local server to receive the OAuth callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing authorization code.");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Success!</h1><p>You can close this tab.</p>");

    console.log("\n--- Add these to your .env file ---\n");
    console.log(`GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to exchange code for tokens.");
    console.error("Token exchange failed:", err.message);
  } finally {
    server.close();
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
});
