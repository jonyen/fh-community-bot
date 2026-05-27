import { matchesGenderEvent } from "../lib/gender-triggers.js";

function shouldSkip(event) {
  if (event.type === "app_mention") return false;

  if (event.type === "message") {
    if (!event.thread_ts) return true;
    if (event.bot_id || event.subtype) return true;
    if (/<@[A-Z0-9_]+>/.test(event.text || "")) return true;
    return false;
  }

  return true;
}

export async function dispatchSlackEvent({ slackEnvelope, handler, genderHandler, client }) {
  const event = slackEnvelope.event;
  if (!event) return;

  if (
    genderHandler &&
    event.type === "message" &&
    !event.bot_id &&
    !event.subtype &&
    matchesGenderEvent(event.text || "")
  ) {
    const sayTopLevel = (msg) =>
      client.chat.postMessage({ channel: event.channel, ...msg });
    await genderHandler({ event, say: sayTopLevel, client });
    return;
  }

  if (shouldSkip(event)) return;

  const say = (msg) =>
    client.chat.postMessage({
      channel: event.channel,
      ...msg,
    });

  await handler({ event, say, client });
}
