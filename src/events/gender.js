import { GENDER_REFRESH_RE, resolveTarget } from "../lib/gender-triggers.js";

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

    if (GENDER_REFRESH_RE.test(text)) {
      try {
        const count = await genderMapService.invalidate();
        await say({ text: `Refreshed gender map. ${count} entries loaded.` });
      } catch (err) {
        await say({ text: `Refresh failed: ${err.message}` });
      }
      return;
    }

    const target = resolveTarget(text);
    if (!target) return;

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

    const targets = members.filter((u) => map[u] === target);
    if (targets.length === 0) {
      await say({ text: `No ${target} members configured for this channel.` });
      return;
    }

    const mentions = targets.map((u) => `<@${u}>`).join(" ");
    const prefix = event.user ? `<@${event.user}> pinged ${target}s:` : `${target} ping:`;
    await say({ text: `${prefix} ${mentions}` });
  };
}
