import { matchesGenderEvent } from "../lib/gender-triggers.js";

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

export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, slashRefreshHandler, maintenanceFormHandler, creaTicketHandler, reservationsHandler, client }) {
  if (slackEnvelope.type === "slash_command") {
    if (slashRefreshHandler && slackEnvelope.command === "/refresh-genders") {
      await slashRefreshHandler({ envelope: slackEnvelope, client });
    }
    if (reservationsHandler?.handleCommand && slackEnvelope.command === "/reserve") {
      await reservationsHandler.handleCommand({
        userId: slackEnvelope.user_id, channel: slackEnvelope.channel_id, text: slackEnvelope.text, client, responseUrl: slackEnvelope.response_url,
      });
    }
    if (reservationsHandler?.disconnect && slackEnvelope.command === "/reservations-disconnect") {
      await reservationsHandler.disconnect({
        userId: slackEnvelope.user_id, channel: slackEnvelope.channel_id, client, responseUrl: slackEnvelope.response_url,
      });
    }
    return;
  }

  // Queued by the OAuth callback once a member has connected Google.
  if (slackEnvelope.type === "oauth_connected") {
    if (reservationsHandler?.resume) await reservationsHandler.resume({ pendingId: slackEnvelope.pendingId, client });
    return;
  }

  // Each block_actions handler ignores action_ids that aren't its own.
  if (slackEnvelope.type === "block_actions") {
    if (maintenanceFormHandler) {
      await maintenanceFormHandler({ payload: slackEnvelope.payload, client });
    }
    if (creaTicketHandler) {
      await creaTicketHandler.handleDraftAction({ payload: slackEnvelope.payload, client });
    }
    if (reservationsHandler?.handleCardAction) {
      await reservationsHandler.handleCardAction({ payload: slackEnvelope.payload, client });
    }
    return;
  }

  // The reservation card's Edit modal was submitted.
  if (slackEnvelope.type === "view_submission") {
    if (reservationsHandler?.handleModalSubmit) await reservationsHandler.handleModalSubmit({ payload: slackEnvelope.payload, client });
    return;
  }

  const event = slackEnvelope.event;
  if (!event) return;

  // #reservations belongs to the reservations flow alone. A mention there
  // arrives as both app_mention and message; only the message is handled.
  if (reservationsHandler && event.channel === reservationsHandler.channelId) {
    if (event.type === "message") await reservationsHandler.handleMessage({ event, client });
    if (event.type === "member_joined_channel" && reservationsHandler.handleMemberJoined) await reservationsHandler.handleMemberJoined({ event, client });
    return;
  }

  if (event.type === "reaction_added") {
    if (creaTicketHandler) await creaTicketHandler.handleReaction({ event, client });
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

  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({
      channel: event.channel,
      // Name the maintenance replies via chat:write.customize, whatever the
      // Slack app itself is called.
      username: "FH Maintenance",
      ...msg,
    });

  await handler({ event, say, client });
}
