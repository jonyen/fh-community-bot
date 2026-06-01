import { categorize } from "../lib/categorize.js";
import { formatMessage, parseWeatherLine, parseHeader } from "../lib/formatMessage.js";

const REACTION_EVENTS = new Set(["reaction_added", "reaction_removed"]);

export function createReactionHandler({ botUserId }) {
  return async function handleReaction({ event, client }) {
    if (!event || !REACTION_EVENTS.has(event.type)) return;
    const { channel, ts } = event.item ?? {};
    if (!channel || !ts) return;

    const history = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const original = history.messages?.[0];
    if (!original || original.ts !== ts || original.user !== botUserId) return;

    const result = await client.reactions.get({ channel, timestamp: ts });
    const roster = categorize(result.message?.reactions ?? [], botUserId);

    const originalText = original.text ?? "";
    const newText = formatMessage(roster, parseWeatherLine(originalText), {
      headerText: parseHeader(originalText),
    });

    try {
      await client.chat.update({ channel, ts, text: newText });
    } catch (err) {
      const code = err.data?.error || err.message;
      if (code === "cant_update_message" || code === "message_not_found") return;
      throw err;
    }
  };
}
