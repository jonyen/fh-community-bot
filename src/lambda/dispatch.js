import { matchesGenderEvent } from "../lib/gender-triggers.js";
import { matchesReservationIntent } from "../lib/reservation-triggers.js";

function shouldSkip(event) {
  if (event.type === "app_mention") return false;

  if (event.type === "message") {
    if (!event.thread_ts) return true;
    if (event.bot_id) return true;
    // Allow file_share (photo uploads) through; skip other subtypes (edits, joins, etc.)
    if (event.subtype && event.subtype !== "file_share") return true;
    if (/<@[A-Z0-9_]+>/.test(event.text || "")) return true;
    return false;
  }

  return true;
}

export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, reservationHandler, client }) {
  if (slackEnvelope.type === "slash_command") {
    if (slashRefreshHandler && slackEnvelope.command === "/refresh-genders") {
      await slashRefreshHandler({ envelope: slackEnvelope, client });
    } else if (reservationHandler && (slackEnvelope.command === "/reserve" || slackEnvelope.command === "/check")) {
      await reservationHandler.handleSlash({ envelope: slackEnvelope, client });
    }
    return;
  }

  const event = slackEnvelope.event;
  if (!event) return;

  if (
    genderHandler &&
    event.type === "message" &&
    !event.bot_id &&
    !event.subtype &&
    matchesGenderEvent(event.text || "")
  ) {
    const say = (msg) =>
      client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        ...msg,
      });
    await genderHandler({ event, say, client });
    return;
  }

  if (
    reservationHandler &&
    (event.type === "app_mention" || (event.type === "message" && event.thread_ts)) &&
    !event.bot_id &&
    matchesReservationIntent(event.text || "")
  ) {
    const say = (msg) =>
      client.chat.postMessage({ channel: event.channel, ...msg });
    await reservationHandler.handleMention({ event, say, client });
    return;
  }

  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({
      channel: event.channel,
      // Append a "(beta)" suffix to the bot's display name on maintenance
      // replies via chat:write.customize, without renaming the Slack app.
      username: "FH Maintenance (beta)",
      ...msg,
    });

  await handler({ event, say, client });
}
