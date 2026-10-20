// src/services/authStore.js
// One DynamoDB table holds connected members, pending bookings and sign-in
// nonces. Refresh tokens are stored only as KMS ciphertext bound to the Slack
// user id, so a copied row is useless without the key and the right user.
// DynamoDB TTL can lag by hours, so every read checks expiresAt itself.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

export const PENDING_TTL_S = 1800;
export const STATE_TTL_S = 600;
// Long past any SQS redelivery; only there so old claims are cleared.
export const BOOKING_CLAIM_TTL_S = 7 * 86400;
export const MAX_BOOKING_REFS = 50;

export function createAuthStore({ ddb, kms, tableName, keyId, now = () => Date.now() }) {
  const nowS = () => Math.floor(now() / 1000);
  const live = (item) => item && (item.expiresAt == null || item.expiresAt > nowS());

  async function saveUser({ slackUserId, googleEmail, refreshToken, scopes }) {
    const enc = await kms.send(new EncryptCommand({
      KeyId: keyId, Plaintext: Buffer.from(refreshToken, "utf8"), EncryptionContext: { slackUserId },
    }));
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `user#${slackUserId}`, googleEmail, scopes: scopes || "",
        refreshTokenCiphertext: Buffer.from(enc.CiphertextBlob).toString("base64"),
        connectedAt: new Date(now()).toISOString(), status: "active",
      },
    }));
  }

  async function getUser(slackUserId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `user#${slackUserId}` } }));
    if (!Item) return null;
    return { googleEmail: Item.googleEmail, status: Item.status, ciphertext: Item.refreshTokenCiphertext };
  }

  async function decryptToken(slackUserId, ciphertext) {
    const res = await kms.send(new DecryptCommand({
      KeyId: keyId, CiphertextBlob: Buffer.from(ciphertext, "base64"), EncryptionContext: { slackUserId },
    }));
    return Buffer.from(res.Plaintext).toString("utf8");
  }

  async function markRevoked(slackUserId) {
    await ddb.send(new UpdateCommand({
      TableName: tableName, Key: { pk: `user#${slackUserId}` },
      UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "revoked" }, ConditionExpression: "attribute_exists(pk)",
    }));
  }

  async function deleteUser(slackUserId) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `user#${slackUserId}` } }));
  }

  async function createPending({ slackUserId, slackEmail, request, channel, threadTs }) {
    const pendingId = randomBytes(16).toString("hex");
    const nonce = randomBytes(32).toString("base64url");
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `pending#${pendingId}`, slackUserId, slackEmail, request, channel, threadTs, expiresAt: nowS() + PENDING_TTL_S },
    }));
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `state#${nonce}`, pendingId, slackUserId, slackEmail, expiresAt: nowS() + STATE_TTL_S },
    }));
    return { pendingId, nonce };
  }

  // Deleting with a condition makes the nonce single use even under a
  // double-click: only one delete returns the old item.
  async function consumeState(nonce) {
    try {
      const { Attributes } = await ddb.send(new DeleteCommand({
        TableName: tableName, Key: { pk: `state#${nonce}` },
        ConditionExpression: "attribute_exists(pk)", ReturnValues: "ALL_OLD",
      }));
      if (!live(Attributes)) return null;
      return { pendingId: Attributes.pendingId, slackUserId: Attributes.slackUserId, slackEmail: Attributes.slackEmail };
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async function getPending(pendingId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `pending#${pendingId}` } }));
    if (!live(Item)) return null;
    return { slackUserId: Item.slackUserId, slackEmail: Item.slackEmail, request: Item.request, channel: Item.channel, threadTs: Item.threadTs };
  }

  async function deletePending(pendingId) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `pending#${pendingId}` } }));
  }

  // Taken just before a booking is written. A second claim of the same key
  // means an earlier delivery of this request already started writing (it
  // timed out, or crashed), so the retry must not write again.
  async function claimBooking(key) {
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: { pk: `booking#${key}`, expiresAt: nowS() + BOOKING_CLAIM_TTL_S },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  // Remembers a booking the bot made for this member so "what do I have
  // booked?" and Cancel can find it later. Past refs are pruned on each write.
  // The row expires two days after the latest ref date (a day of slack).
  async function recordBooking(slackUserId, ref, { today }) {
    const pk = `bookings#${slackUserId}`;
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk } }));
    const kept = (live(Item) ? Item.refs : []).filter((r) => r.date >= today);
    const refs = [...kept, ref].slice(-MAX_BOOKING_REFS);
    const latest = refs.reduce((max, r) => (r.date > max ? r.date : max), refs[0].date);
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { pk, refs, expiresAt: Date.parse(`${latest}T00:00:00Z`) / 1000 + 2 * 86400 },
    }));
  }

  async function bookingsFor(slackUserId, { today }) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `bookings#${slackUserId}` } }));
    if (!live(Item)) return [];
    return Item.refs.filter((r) => r.date >= today);
  }

  return { saveUser, getUser, decryptToken, markRevoked, deleteUser, createPending, consumeState, getPending, deletePending, claimBooking, recordBooking, bookingsFor };
}
