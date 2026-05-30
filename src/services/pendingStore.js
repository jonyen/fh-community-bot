import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

// Default time-to-live for a pending severity prompt. After this window the
// "How severe is this issue?" question is considered abandoned and the record
// auto-expires via DynamoDB TTL, so a much-later reply is treated as a fresh
// message rather than a stale severity answer.
const DEFAULT_TTL_SECONDS = 24 * 3600;

// DynamoDB-backed store for pending maintenance issues awaiting a severity
// reply. Exposes a Map-like async interface (get/set/delete) so it can be
// dropped in wherever the in-memory Map was used. State lives outside any
// single Lambda container, so the severity prompt and the reply can land on
// different containers (or after a cold start) without losing context.
export function createPendingStore({ docClient, tableName, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!docClient) {
    const ddb = new DynamoDBClient({});
    docClient = DynamoDBDocumentClient.from(ddb, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async function get(key) {
    const res = await docClient.send(
      new GetCommand({ TableName: tableName, Key: { pk: key } })
    );
    return res.Item ? res.Item.data : undefined;
  }

  async function set(key, value) {
    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: key, data: value, ttl },
      })
    );
  }

  async function del(key) {
    await docClient.send(
      new DeleteCommand({ TableName: tableName, Key: { pk: key } })
    );
  }

  return { get, set, delete: del };
}
