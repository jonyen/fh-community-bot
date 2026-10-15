// src/lambda/oauthCallback.js
// Google redirects here after a member approves (or declines) access. It is
// its own Lambda, off the Slack receiver, so googleapis and the token
// exchange never slow the receiver against Slack's 3 s deadline. Nothing
// secret ever goes into the page, the logs or the queue: the queue only gets
// the pending booking id.
import { checkIdentity, htmlPage, OAUTH_CALLBACK_PATH, HOSTED_DOMAIN } from "../lib/google-oauth.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "connect" };

export function createOAuthCallback({ authStore, oauth2Client, clientId, enqueue }) {
  return async function handle({ query = {}, redirectUri }) {
    const { code, state, error } = query;
    if (!state) return htmlPage(400, "This link isn't valid", "Ask again in #reservations.");

    const consumed = await authStore.consumeState(state);
    if (!consumed) return htmlPage(400, "This link has expired", "Ask again in #reservations and use the new button.");

    if (error) {
      await authStore.deletePending(consumed.pendingId);
      return htmlPage(200, "Not connected", "Nothing was booked. You can close this tab.");
    }
    if (!code) return htmlPage(400, "This link isn't valid", "Ask again in #reservations.");

    let tokens;
    let payload;
    try {
      ({ tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri }));
      const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "exchange" } });
      log.error("google code exchange failed", { error: err });
      return htmlPage(502, "Couldn't connect", "Google didn't accept the sign-in. Please try again from Slack.");
    }

    const identity = checkIdentity(payload, consumed.slackEmail);
    if (!identity.ok) {
      try {
        await oauth2Client.revokeToken(tokens.refresh_token || tokens.access_token);
      } catch (err) {
        log.warn("revoking a rejected token failed", { error: err });
      }
      metric("ConnectRejected", 1, { dimensions: DIMENSIONS, fields: { reason: identity.reason } });
      const message = identity.reason === "mismatch"
        ? `You signed in as ${identity.email}, but your Slack account is ${consumed.slackEmail}. Please sign in as ${consumed.slackEmail}.`
        : `Please sign in with your ${HOSTED_DOMAIN} account (${consumed.slackEmail}).`;
      return htmlPage(403, "Wrong Google account", message);
    }

    if (!tokens.refresh_token) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "no_refresh_token" } });
      return htmlPage(502, "Couldn't connect", "Google didn't return offline access. Please try again from Slack.");
    }

    try {
      await authStore.saveUser({ slackUserId: consumed.slackUserId, googleEmail: identity.email, refreshToken: tokens.refresh_token, scopes: tokens.scope });
    } catch (err) {
      metric("ConnectFailed", 1, { dimensions: DIMENSIONS, fields: { stage: "store" } });
      log.error("storing google token failed", { error: err });
      return htmlPage(502, "Couldn't connect", "Something went wrong on our side. Please try again from Slack.");
    }
    metric("Connected", 1, { dimensions: DIMENSIONS });

    const pending = await authStore.getPending(consumed.pendingId);
    if (!pending) {
      return htmlPage(200, "Connected", "Your Google account is connected. Please send your request again in #reservations.");
    }
    await enqueue({ type: "oauth_connected", pendingId: consumed.pendingId });
    return htmlPage(200, "Connected", "You can close this tab and go back to Slack. Your booking is being made now.");
  };
}

let cached;
async function getCallback() {
  if (cached !== undefined) return cached;
  const { GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, AUTH_TABLE, AUTH_KMS_KEY_ID, EVENT_QUEUE_URL } = process.env;
  if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_WEB_CLIENT_SECRET || !AUTH_TABLE || !AUTH_KMS_KEY_ID || !EVENT_QUEUE_URL) {
    cached = null;
    return cached;
  }
  const [{ google }, { DynamoDBClient }, { DynamoDBDocumentClient }, { KMSClient }, { SQSClient, SendMessageCommand }, { createAuthStore }] =
    await Promise.all([
      import("googleapis"), import("@aws-sdk/client-dynamodb"), import("@aws-sdk/lib-dynamodb"),
      import("@aws-sdk/client-kms"), import("@aws-sdk/client-sqs"), import("../services/authStore.js"),
    ]);
  const sqs = new SQSClient({});
  cached = createOAuthCallback({
    authStore: createAuthStore({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      kms: new KMSClient({}),
      tableName: AUTH_TABLE,
      keyId: AUTH_KMS_KEY_ID,
    }),
    oauth2Client: new google.auth.OAuth2(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET),
    clientId: GOOGLE_WEB_CLIENT_ID,
    enqueue: (body) => sqs.send(new SendMessageCommand({ QueueUrl: EVENT_QUEUE_URL, MessageBody: JSON.stringify(body) })),
  });
  return cached;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method;
  if (method !== "GET" || event.rawPath !== OAUTH_CALLBACK_PATH) return htmlPage(404, "Not found", "Nothing here.");
  const callback = await getCallback();
  if (!callback) return htmlPage(503, "Not set up", "Google connect isn't configured yet.");
  // The redirect URI must match the one in the consent URL exactly; it is
  // this function's own URL, so it is rebuilt from the request host.
  const redirectUri = `https://${event.requestContext.domainName}${OAUTH_CALLBACK_PATH}`;
  return callback({ query: event.queryStringParameters || {}, redirectUri });
}
