import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature.js";
import { matchesGenderEvent } from "../lib/gender-triggers.js";
import { isCreaTicketReaction } from "../lib/crea-ticket.js";
import { parseBballChannelIds } from "../lib/bball-format.js";
import { loadReservations } from "../config.js";
import { buildCatalog } from "../lib/reservation-catalog.js";
import { buildRmsCatalog } from "../lib/rms-catalog.js";
import { handleReservationInteraction } from "./reservation-interactions.js";

const sqs = new SQSClient({});

// The bookable items, for the Edit modal and its typeahead. Built the same
// way as the worker's, from the bundled config; null when reservations are off.
let reservationCatalog;
function receiverCatalog() {
  if (reservationCatalog === undefined) {
    const res = loadReservations();
    reservationCatalog = res
      ? buildCatalog({ rooms: !!res.roomsSheetId, kitchen: !!res.kitchenSheetId, rms: buildRmsCatalog(res.resourceCalendars) })
      : null;
  }
  return reservationCatalog;
}

export function _resetReceiverCatalogForTests() {
  reservationCatalog = undefined;
}

// views.open must happen before the trigger_id expires, so the receiver calls
// Slack directly instead of loading the Web API client.
async function openView({ trigger_id, view, response_url }) {
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ trigger_id, view }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.ok) return;
  console.log(`[receiver] views.open failed: ${data.error || res.status}`);
  if (!response_url) return;
  await fetch(response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: "I couldn't open the edit form. Please press Edit again." }),
  }).catch(() => {});
}

function enqueue(body, groupId) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.EVENT_QUEUE_URL,
      MessageBody: body,
      MessageGroupId: groupId || "slack",
    })
  );
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Slack gives this endpoint 3 seconds to respond and redelivers the identical
// payload up to three times when it doesn't hear back in time. A cold start
// blows that budget easily, and every redelivery used to be enqueued as a
// fresh event — which is how one @mention became three report forms in a
// thread, and one Submit became three rows in the sheet.
//
// `http_timeout` means Slack reached us and we simply answered late: the
// original invocation is still running and will enqueue, so the retry is a
// duplicate and gets dropped. Any other reason (we returned an error, Slack
// couldn't connect) means the first attempt may never have landed, so those
// are still processed.
export function isDuplicateSlackRetry(headers) {
  const retryNum = getHeader(headers, "x-slack-retry-num");
  if (!retryNum) return false;
  const reason = (getHeader(headers, "x-slack-retry-reason") || "http_timeout").toLowerCase();
  return reason === "http_timeout";
}

function readBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

// A reaction on a message in a basketball roll-call channel. Any emoji counts
// there: it's someone's RSVP.
function isBballReaction(event) {
  if (event.type !== "reaction_added" && event.type !== "reaction_removed") return false;
  const channel = event.item?.channel;
  return !!channel && parseBballChannelIds(process.env.BBALL_CHANNEL_IDS).includes(channel);
}

// The event queue is FIFO. Grouping by the Slack user means one member's
// messages are handled one at a time, in order, so two quick messages can't
// both pass a conflict check. Different members still run in parallel.
// Reactions on a roll-call are grouped by the message instead, so everyone's
// RSVPs to one post are applied in order and two rewrites of it can't race.
export function messageGroup(parsed) {
  const event = parsed.event || {};
  if (isBballReaction(event)) return `bball:${event.item.channel}:${event.item.ts}`;
  return event.user || event.channel || "slack";
}

export function shouldEnqueueEvent(parsed) {
  const event = parsed.event;
  if (!event) return false;
  // Every reaction in every channel the bot is in arrives here. In a
  // basketball channel any emoji is an RSVP; elsewhere only the ticket emoji
  // means anything, so drop the rest before they cost a Lambda.
  if (isBballReaction(event)) return true;
  if (event.type === "reaction_added") return isCreaTicketReaction(event.reaction);
  if (event.type === "reaction_removed") return false;
  if (event.type !== "message") return true;
  if (event.bot_id) return false; // never enqueue our own / other bots' messages
  // #reservations: every top-level message is a possible request. Thread
  // replies there are people talking to each other.
  const reservationsChannel = process.env.RESERVATIONS_CHANNEL_ID;
  if (reservationsChannel && event.channel === reservationsChannel) {
    return !event.thread_ts && (!event.subtype || event.subtype === "file_share");
  }
  if (event.channel_type === "im") return false;
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
    trigger_id: params.get("trigger_id") || undefined,
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

  // Ack (so Slack stops retrying) but don't enqueue — the first delivery of
  // this same payload is already on the queue.
  if (isDuplicateSlackRetry(event.headers)) {
    console.log(
      `[receiver] dropping Slack retry num=${getHeader(event.headers, "x-slack-retry-num")} reason=${getHeader(event.headers, "x-slack-retry-reason")}`
    );
    return { statusCode: 200, body: "" };
  }

  if (isFormEncoded(contentType)) {
    const params = new URLSearchParams(body);
    const interactivityPayload = params.get("payload");
    if (interactivityPayload) {
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(interactivityPayload);
      } catch {
        return { statusCode: 400, body: "invalid interactivity payload" };
      }
      const catalog = receiverCatalog();
      if (catalog) {
        const result = await handleReservationInteraction(parsedPayload, { catalog, openView });
        if (result.handled) {
          return result.response
            ? { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result.response) }
            : { statusCode: 200, body: "" };
        }
      }
      // An empty 200 to a view_submission closes the modal.
      if (parsedPayload.type !== "block_actions" && parsedPayload.type !== "view_submission") {
        return { statusCode: 200, body: "" };
      }
      await enqueue(JSON.stringify({ type: parsedPayload.type, payload: parsedPayload }), parsedPayload.user?.id);
      return { statusCode: 200, body: "" };
    }

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
      trigger_id: slash.trigger_id,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.EVENT_QUEUE_URL,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: slash.user_id || "slack",
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
      MessageGroupId: messageGroup(parsed),
    })
  );

  return { statusCode: 200, body: "" };
}
