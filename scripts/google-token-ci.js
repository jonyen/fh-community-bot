/**
 * CI-friendly Google OAuth2 refresh-token issuer, driven entirely from GitHub
 * Actions (where GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are readable). Unlike
 * scripts/get-google-token.js, this never starts a local server — a GitHub
 * runner can't receive the OAuth redirect — so it runs in two phases:
 *
 *   Phase 1 (AUTH_CODE empty): print the consent URL.
 *   Phase 2 (AUTH_CODE set):   exchange the code for a refresh token.
 *
 * Env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — the OAuth Desktop client.
 *   AUTH_CODE                               — the `code` from the redirect, or
 *                                             the full localhost redirect URL.
 */

import { writeFileSync } from "node:fs";
import { google } from "googleapis";

// Phase 1 writes the consent URL here so the workflow can upload it as an
// artifact. GitHub masks the client_id (a secret) in LOGS, but artifact file
// contents are not scrubbed, so the downloaded URL stays usable.
const AUTH_URL_FILE = "google-auth-url.txt";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const authCodeRaw = process.env.AUTH_CODE || "";

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the environment."
  );
  process.exit(1);
}

// Loopback redirect: a Desktop OAuth client accepts http://localhost on any
// port without registration. The page won't load (no server) — that's fine,
// the `code` lands in the address bar. Must be identical across both phases.
const REDIRECT_URI = "http://localhost:3456";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar",
];

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

// Accept either the bare code or the whole redirect URL, encoded or not.
function extractCode(raw) {
  const s = raw.trim();
  const m = s.match(/[?&]code=([^&\s]+)/);
  const code = m ? m[1] : s;
  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

if (!authCodeRaw.trim()) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  writeFileSync(AUTH_URL_FILE, authUrl + "\n");
  console.log("\n=== STEP 1 — get the sign-in URL ===\n");
  console.log(
    "The URL contains the client_id, which GitHub masks in these logs. Download\n" +
      "the 'google-auth-url' artifact from this run instead — it has the real URL.\n\n" +
      "Open it, sign in with the Google account that owns the spreadsheet and the\n" +
      "Drive folder, and approve. Google then redirects to http://localhost:3456/?code=...\n" +
      "The page will fail to load — that is expected. Copy the FULL address-bar URL\n" +
      "(or just the code= value) and re-run this workflow with it in the 'auth_code'\n" +
      "input.\n\n" +
      "(masked preview below — use the artifact, not this:)\n"
  );
  console.log(authUrl);
} else {
  const code = extractCode(authCodeRaw);
  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken(code));
  } catch (err) {
    console.error(
      "\nToken exchange failed:",
      err.message,
      "\nThe code is single-use and expires quickly — redo STEP 1 to get a fresh one.\n"
    );
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    console.error(
      "\nNo refresh_token was returned. Revoke the app at\n" +
        "https://myaccount.google.com/permissions and redo STEP 1.\n"
    );
    process.exit(1);
  }

  console.log("\n=== STEP 2 — your new GOOGLE_REFRESH_TOKEN ===\n");
  console.log(tokens.refresh_token);
  console.log(
    "\nSet it as the GOOGLE_REFRESH_TOKEN Actions secret:\n" +
      "  GitHub → Settings → Secrets and variables → Actions → GOOGLE_REFRESH_TOKEN\n" +
      "Then redeploy (gh workflow run deploy.yml) and DELETE this workflow run so\n" +
      "the token doesn't linger in the logs.\n"
  );
}
