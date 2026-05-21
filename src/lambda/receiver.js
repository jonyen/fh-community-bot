import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature.js";

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

export async function handler(event) {
  const body = readBody(event);
  const timestamp = getHeader(event.headers, "x-slack-request-timestamp");
  const signature = getHeader(event.headers, "x-slack-signature");

  const ok = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    body,
    timestamp,
    signature,
  });
  if (!ok) {
    return { statusCode: 401, body: "invalid signature" };
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

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: body,
    })
  );

  return { statusCode: 200, body: "" };
}
