/**
 * One-time script to (re)issue a Google OAuth2 refresh token with the scopes
 * this bot needs (Sheets + Drive), and optionally write it straight to the
 * GitHub Actions secret the deploy workflow reads.
 *
 * Client credentials:
 *   GitHub Actions secrets are write-only — GOOGLE_CLIENT_ID and
 *   GOOGLE_CLIENT_SECRET cannot be read back from GitHub. Provide them as args
 *   or env vars. Find them in Google Cloud Console → APIs & Services →
 *   Credentials → your OAuth 2.0 Client ID (Desktop app).
 *
 * Usage:
 *   node scripts/get-google-token.js <client_id> <client_secret> [--set-gh-secret]
 *
 *   # or pass the credentials via env (so they don't land in shell history):
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *     node scripts/get-google-token.js --set-gh-secret
 *
 * This opens a browser for you to sign in and grant Sheets + Drive access.
 * The refresh token is printed to the console. With --set-gh-secret it is also
 * written to the repo's GOOGLE_REFRESH_TOKEN Actions secret via the `gh` CLI
 * (gh must be installed and authenticated). Either way, redeploy afterward so
 * the Lambda picks up the new value (`gh workflow run deploy.yml`).
 */

import http from "node:http";
import { execFileSync } from "node:child_process";
import { google } from "googleapis";

const argv = process.argv.slice(2);
const setGhSecret = argv.includes("--set-gh-secret");
const positionals = argv.filter((a) => !a.startsWith("--"));

const clientId = positionals[0] || process.env.GOOGLE_CLIENT_ID;
const clientSecret = positionals[1] || process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Usage: node scripts/get-google-token.js <client_id> <client_secret> [--set-gh-secret]\n" +
      "  (or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the environment)\n\n" +
      "Find the client ID/secret in Google Cloud Console → APIs & Services →\n" +
      "Credentials → your OAuth 2.0 Client ID (Desktop app). GitHub secrets are\n" +
      "write-only, so they cannot be read back from gh."
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
    "https://www.googleapis.com/auth/calendar",
  ],
});

// Write the new refresh token to the GOOGLE_REFRESH_TOKEN Actions secret.
// The value is piped via stdin so it never appears in the process arg list.
function setGitHubSecret(refreshToken) {
  execFileSync("gh", ["secret", "set", "GOOGLE_REFRESH_TOKEN"], {
    input: refreshToken,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

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

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token was returned. Revoke the app's access at\n" +
          "https://myaccount.google.com/permissions and run this again so Google\n" +
          "re-issues one (the script already forces prompt=consent)."
      );
      return;
    }

    console.log("\n--- Add these to your .env file ---\n");
    console.log(`GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log();

    if (setGhSecret) {
      try {
        setGitHubSecret(tokens.refresh_token);
        console.log(
          "Updated GitHub Actions secret GOOGLE_REFRESH_TOKEN.\n" +
            "Redeploy to apply it: gh workflow run deploy.yml\n"
        );
      } catch (err) {
        console.error(
          "Failed to set the GitHub secret via gh:",
          err.message,
          "\nSet it manually: gh secret set GOOGLE_REFRESH_TOKEN\n"
        );
      }
    } else {
      console.log(
        "Tip: re-run with --set-gh-secret to write this straight to the\n" +
          "GOOGLE_REFRESH_TOKEN Actions secret. Then: gh workflow run deploy.yml\n"
      );
    }
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
