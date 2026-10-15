// src/lib/google-oauth.js
// Per-member Google sign-in for #reservations. Only acts2.network accounts,
// and only the account whose email matches the member's Slack profile, so
// nobody can attach someone else's Google account to their Slack identity.
export const OAUTH_CALLBACK_PATH = "/oauth/google/callback";
export const HOSTED_DOMAIN = "acts2.network";
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function buildConsentUrl({ clientId, redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent: Google only returns a refresh token on a fresh consent.
    access_type: "offline",
    prompt: "consent",
    hd: HOSTED_DOMAIN,
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function checkIdentity(payload, expectedEmail) {
  const email = payload?.email || null;
  if (!payload?.email_verified) return { ok: false, reason: "unverified", email };
  if (payload.hd !== HOSTED_DOMAIN) return { ok: false, reason: "domain", email };
  if (String(email).toLowerCase() !== String(expectedEmail || "").toLowerCase()) {
    return { ok: false, reason: "mismatch", email };
  }
  return { ok: true, email };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function htmlPage(statusCode, title, message) {
  const t = escapeHtml(title);
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1d1f;background:#fff}@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}h1{font-size:1.4rem}</style></head>
<body><h1>${t}</h1><p>${escapeHtml(message)}</p></body></html>`,
  };
}
