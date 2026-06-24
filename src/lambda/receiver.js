import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature.js";
import { matchesGenderEvent } from "../lib/gender-triggers.js";

const sqs = new SQSClient({});

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function readBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

export function shouldEnqueueEvent(parsed) {
  const event = parsed.event;
  if (!event) return false;
  if (event.type !== "message") return true;
  if (event.bot_id) return false; // never enqueue our own / other bots' messages
  const onestopChannelId = process.env.ONESTOP_CHANNEL_ID || process.env.RESERVATIONS_CHANNEL_ID;
  if (onestopChannelId && event.channel === onestopChannelId) {
    return true; // ambient OneStop channel: every human message
  }
  const text = event.text || "";
  if (matchesGenderEvent(text)) return true;
  if (/<@[A-Z0-9_]+>/.test(text)) return true;
  if (event.thread_ts) return true;
  return false;
}

function isFormEncoded(contentType) {
  return (contentType || "").toLowerCase().startsWith("application/x-www-form-urlencoded");
}

function parseSlashCommand(body) {
  const params = new URLSearchParams(body);
  return {
    command: params.get("command"),
    user_id: params.get("user_id"),
    channel_id: params.get("channel_id"),
    team_id: params.get("team_id"),
    response_url: params.get("response_url"),
    text: params.get("text") || "",
  };
}

export async function handler(event) {
  const body = readBody(event);
  const timestamp = getHeader(event.headers, "x-slack-request-timestamp");
  const signature = getHeader(event.headers, "x-slack-signature");
  const contentType = getHeader(event.headers, "content-type");

  const ok = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    body,
    timestamp,
    signature,
  });
  if (!ok) {
    return { statusCode: 401, body: "invalid signature" };
  }

  if (isFormEncoded(contentType)) {
    const slash = parseSlashCommand(body);
    if (!slash.command || !slash.response_url) {
      return { statusCode: 400, body: "invalid slash command payload" };
    }
    const envelope = {
      type: "slash_command",
      command: slash.command,
      user_id: slash.user_id,
      channel_id: slash.channel_id,
      team_id: slash.team_id,
      response_url: slash.response_url,
      text: slash.text,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.EVENT_QUEUE_URL,
        MessageBody: JSON.stringify(envelope),
      })
    );
    return { statusCode: 200, body: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "invalid json" };
  }

  if (parsed.type === "url_verification") {
    return { statusCode: 200, body: parsed.challenge };
  }

  if (!shouldEnqueueEvent(parsed)) {
    return { statusCode: 200, body: "" };
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: body,
    })
  );

  return { statusCode: 200, body: "" };
}
