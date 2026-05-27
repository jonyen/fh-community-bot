import {
  referencedGenders,
  formatGenderReply,
} from "../lib/gender-triggers.js";

async function fetchCallerPersona(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user || {};
    const profile = u.profile || {};
    return {
      username: profile.display_name || u.real_name || u.name || null,
      icon_url: profile.image_72 || profile.image_48 || profile.image_192 || null,
    };
  } catch (err) {
    console.warn(`[gender] users.info failed for ${userId}: ${err.message}`);
    return null;
  }
}

async function sendSystemEphemeral({ client, channel, user, text, fallbackSay }) {
  if (user) {
    try {
      await client.chat.postEphemeral({
        channel,
        user,
        text,
        username: "Gender Aliases",
        icon_emoji: ":busts_in_silhouette:",
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
    if (genders.size === 0) return;

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

    const empties = [...genders].filter((g) => !mentionsByGender[g]);
    if (empties.length === genders.size) {
      const label = empties.join("/");
      await sendSystemEphemeral({
        client,
        channel: event.channel,
        user: event.user,
        text: `No ${label} members configured for this channel.`,
        fallbackSay: say,
      });
      return;
    }

    const replyText = formatGenderReply(text, mentionsByGender);

    const persona = event.user ? await fetchCallerPersona(client, event.user) : null;
    const msg = { text: replyText };
    if (persona) {
      if (persona.username) msg.username = persona.username;
      if (persona.icon_url) msg.icon_url = persona.icon_url;
    }
    try {
      await say(msg);
    } catch (err) {
      const code = err.data?.error;
      if (code === "not_allowed_token_type" || code === "missing_scope") {
        console.warn(`[gender] chat:write.customize unavailable (${code}); posting as bot`);
        await say({ text: replyText });
      } else {
        throw err;
      }
    }
  };
}
