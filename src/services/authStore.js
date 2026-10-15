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

  return { saveUser, getUser, decryptToken, markRevoked, deleteUser, createPending, consumeState, getPending, deletePending };
}
