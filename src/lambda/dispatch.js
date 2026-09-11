import { matchesGenderEvent } from "../lib/gender-triggers.js";
import { matchesReservationIntent } from "../lib/reservation-triggers.js";

// The maintenance handler only ever acts on an explicit @mention. Plain
// thread replies (even inside an issue's thread) are other people's
// conversation and never reach it.
function shouldSkip(event) {
  return event.type !== "app_mention";
}

export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, reservationHandler, maintenanceFormHandler, onestopChannelId, client }) {
  if (slackEnvelope.type === "slash_command") {
    if (slashRefreshHandler && slackEnvelope.command === "/refresh-genders") {
      await slashRefreshHandler({ envelope: slackEnvelope, client });
    } else if (
      reservationHandler &&
      (slackEnvelope.command === "/reserve" ||
        slackEnvelope.command === "/check" ||
        slackEnvelope.command === "/list")
    ) {
      await reservationHandler.handleSlash({ envelope: slackEnvelope, client });
    }
    return;
  }

  if (slackEnvelope.type === "block_actions") {
    if (maintenanceFormHandler) {
      await maintenanceFormHandler({ payload: slackEnvelope.payload, client });
    }
    return;
  }

  const event = slackEnvelope.event;
  if (!event) return;

  if (
    reservationHandler &&
    onestopChannelId &&
    event.type === "message" &&
    !event.bot_id &&
    event.channel === onestopChannelId
  ) {
    await reservationHandler.handleChannelMessage({ event, client });
    return;
  }

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

  // Reservation intent outside the OneStop channel only responds to an explicit
  // @mention of the bot. Plain thread replies are NOT routed here on a keyword
  // match — a message like "FH maintenance isn't available in this channel"
  // must not summon OneStop in a channel it doesn't own. (Inside the OneStop
  // channel, every message is already handled by the ambient path above.)
  if (
    reservationHandler &&
    event.type === "app_mention" &&
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
