import { referencedGenders } from "../lib/gender-triggers.js";

const BOT_USERNAME = "Gender Aliases";
const BOT_ICON_EMOJI = ":busts_in_silhouette:";

async function sendSystemEphemeral({ client, channel, user, text, fallbackSay }) {
  if (user) {
    try {
      await client.chat.postEphemeral({
        channel,
        user,
        text,
        username: BOT_USERNAME,
        icon_emoji: BOT_ICON_EMOJI,
      });
      return;
    } catch (err) {
      const code = err.data?.error || err.message;
      console.warn(`[gender] postEphemeral failed (${code}); falling back to public reply`);
    }
  }
  await fallbackSay({ text });
}

async function fetchAllMembers(client, channel) {
  const all = [];
  let cursor;
  for (;;) {
    const args = { channel, limit: 200 };
    if (cursor) args.cursor = cursor;
    const res = await client.conversations.members(args);
    if (Array.isArray(res.members)) all.push(...res.members);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!cursor) break;
  }
  return all;
}

export function createGenderHandler({ genderMapService }) {
  return async function handleGender({ event, say, client }) {
    const text = event.text || "";
    const genders = referencedGenders(text);
    if (genders.length === 0) return;

    let map;
    try {
      map = await genderMapService.getMap();
    } catch (err) {
      await say({ text: `Could not load gender map: ${err.message}` });
      return;
    }

    let members;
    try {
      members = await fetchAllMembers(client, event.channel);
    } catch (err) {
      await say({ text: `Could not list channel members: ${err.message}` });
      return;
    }

    const mentionsByGender = {};
    for (const g of genders) {
      const ids = members.filter((u) => map[u] === g);
      mentionsByGender[g] = ids.length > 0 ? ids.map((u) => `<@${u}>`).join(" ") : null;
    }

    const empties = genders.filter((g) => !mentionsByGender[g]);
    if (empties.length === genders.length) {
      await sendSystemEphemeral({
        client,
        channel: event.channel,
        user: event.user,
        text: `No ${empties.join("/")} members configured for this channel.`,
        fallbackSay: say,
      });
      return;
    }

    const parts = genders.map((g) => mentionsByGender[g]).filter(Boolean);
    await say({
      text: parts.join(" "),
      username: BOT_USERNAME,
      icon_emoji: BOT_ICON_EMOJI,
    });
  };
}
