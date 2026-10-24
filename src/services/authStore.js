// src/services/authStore.js
// One DynamoDB table holds connected members, pending bookings and sign-in
// nonces. Refresh tokens are stored only as KMS ciphertext bound to the Slack
// user id, so a copied row is useless without the key and the right user.
// DynamoDB TTL can lag by hours, so every read checks expiresAt itself.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { TRAY_TTL_S } from "../lib/reservation-tray.js";
import { refKey } from "../lib/reservation-owner.js";

export const PENDING_TTL_S = 1800;
export const STATE_TTL_S = 600;
// Long past any SQS redelivery; only there so old claims are cleared.
export const BOOKING_CLAIM_TTL_S = 7 * 86400;
export const MAX_BOOKING_REFS = 50;

// The real document client rejects undefined values unless told to drop them.
const defined = (v) => JSON.parse(JSON.stringify(v));

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

  // True the first time a key is claimed within ttlS seconds. Used to say
  // something to a member once (the #reservations welcome, the /reserve
  // tip) however many events would trigger it. TTL deletion lags, so an
  // expired claim may be retaken before DynamoDB removes it.
  async function claimOnce(key, ttlS) {
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: { pk: `once#${key}`, expiresAt: nowS() + ttlS },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": nowS() },
      }));
      return true;
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  // The ledger row holds single refs and booked series side by side. Each
  // write sets only its own attribute so it cannot clobber the other, and
  // expiresAt covers the latest date of either list plus two days (a day of slack).
  const ledgerExpiry = (refs, series) => {
    const dates = [...refs, ...series.flatMap((s) => s.refs)].map((r) => r.date);
    if (!dates.length) return nowS() + 2 * 86400;
    const latest = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
    return Date.parse(`${latest}T00:00:00Z`) / 1000 + 2 * 86400;
  };

  async function readLedger(slackUserId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `bookings#${slackUserId}` } }));
    return live(Item) ? { refs: Item.refs || [], series: Item.series || [] } : { refs: [], series: [] };
  }

  async function writeLedger(slackUserId, attr, value, refs, series) {
    await ddb.send(new UpdateCommand({
      TableName: tableName, Key: { pk: `bookings#${slackUserId}` },
      UpdateExpression: "SET #a = :v, expiresAt = :e", ExpressionAttributeNames: { "#a": attr },
      ExpressionAttributeValues: { ":v": defined(value), ":e": ledgerExpiry(refs, series) },
    }));
  }

  // Remembers a booking the bot made for this member so "what do I have
  // booked?" and Cancel can find it later. Past refs are pruned on each write.
  async function recordBooking(slackUserId, ref, { today }) {
    const { refs: old, series } = await readLedger(slackUserId);
    const refs = [...old.filter((r) => r.date >= today), ref].slice(-MAX_BOOKING_REFS);
    await writeLedger(slackUserId, "refs", refs, refs, series);
  }

  // A booked series is kept whole so Cancel can offer it; series whose refs
  // have all ended are pruned on each write.
  async function recordSeries(slackUserId, series, { today }) {
    if (!series.refs.some((r) => r.date >= today)) return;
    const { refs, series: old } = await readLedger(slackUserId);
    const all = [...old.filter((s) => s.refs.some((r) => r.date >= today)), series];
    await writeLedger(slackUserId, "series", all, refs, all);
  }

  async function seriesFor(slackUserId, { today }) {
    const { series } = await readLedger(slackUserId);
    return series
      .map((s) => ({ ...s, refs: s.refs.filter((r) => r.date >= today) }))
      .filter((s) => s.refs.length);
  }

  async function dropSeriesRefs(slackUserId, id, keys) {
    const { refs, series } = await readLedger(slackUserId);
    if (!series.some((s) => s.id === id)) return;
    const next = series
      .map((s) => (s.id === id ? { ...s, refs: s.refs.filter((r) => !keys.includes(refKey(r))) } : s))
      .filter((s) => s.refs.length);
    if (!next.length && !refs.length) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `bookings#${slackUserId}` } }));
      return;
    }
    await writeLedger(slackUserId, "series", next, refs, next);
  }

  async function bookingsFor(slackUserId, { today }) {
    const { refs, series } = await readLedger(slackUserId);
    return [...refs, ...series.flatMap((s) => s.refs)].filter((r) => r.date >= today);
  }

  async function getTray(slackUserId) {
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: `tray#${slackUserId}` } }));
    if (!live(Item)) return null;
    const { pk, expiresAt, ...tray } = Item;
    return tray;
  }

  // Version-checked so two quick button presses cannot both win. Version 0
  // means "no tray yet": an expired row counts as absent, since TTL lags.
  async function putTray(slackUserId, tray, { expectVersion }) {
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: { ...defined(tray), pk: `tray#${slackUserId}`, version: expectVersion + 1, expiresAt: nowS() + TRAY_TTL_S },
        ConditionExpression: expectVersion === 0 ? "attribute_not_exists(pk) OR expiresAt <= :now" : "#v = :v",
        ...(expectVersion === 0
          ? { ExpressionAttributeValues: { ":now": nowS() } }
          : { ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": expectVersion } }),
      }));
      return true;
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async function deleteTray(slackUserId) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `tray#${slackUserId}` } }));
  }

  return { saveUser, getUser, decryptToken, markRevoked, deleteUser, createPending, consumeState, getPending, deletePending, claimBooking, claimOnce, recordBooking, recordSeries, seriesFor, dropSeriesRefs, bookingsFor, getTray, putTray, deleteTray };
}
