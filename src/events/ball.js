import { categorize } from "../lib/categorize.js";
import { formatMessage } from "../lib/formatMessage.js";
import { sendEphemeral } from "../lib/ephemeral.js";

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const WEATHER_TIMEOUT_MS = 2000;

const USAGE_HELP = [
  "*Usage*",
  "• `/ball <message>` — post a new bball message",
  "• `/ball edit <message>` — edit the most recent bball message",
  "• `/ball delete` — delete the most recent bball message",
  "• `/ball info` — show the deployed commit SHA and GitHub run number",
].join("\n");

async function recentBotMessage({ client, channel, botUserId }) {
  const history = await client.conversations.history({ channel, limit: 20 });
  return (history.messages ?? []).find((m) => m.user === botUserId);
}

async function resolveDisplayName({ client, userId }) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info?.user?.profile;
    return profile?.display_name?.trim() || profile?.real_name?.trim() || userId;
  } catch (err) {
    console.error("users.info fetch failed", err);
    return userId;
  }
}

async function safeWeather(fetchWeather) {
  try {
    return await fetchWeather({ timeoutMs: WEATHER_TIMEOUT_MS, target: "now" });
  } catch (err) {
    console.error("weather fetch failed", err);
    return null;
  }
}

export function createBallHandler({ fetchWeather, botUserId, gitSha = "unknown", runNumber = "unknown" }) {
  return async function handleBall({ envelope, client }) {
    const text = (envelope.text ?? "").trim();
    const channel = envelope.channel_id;
    const userId = envelope.user_id;
    const reply = (msg) =>
      sendEphemeral({ client, channel, user: userId, responseUrl: envelope.response_url, text: msg });

    if (!text) return reply(USAGE_HELP);

    if (/^info\s*$/i.test(text)) {
      return reply(`*bball bot*\n• Commit: \`${gitSha}\`\n• GitHub run: \`#${runNumber}\``);
    }

    if (/^schedule\b/i.test(text)) {
      return reply(
        "Schedule changes are managed via deploy now (the runtime `/ball schedule` control was removed)."
      );
    }

    if (!channel) return reply("Could not determine the current channel.");

    try {
      if (/^delete\s*$/i.test(text)) {
        const target = await recentBotMessage({ client, channel, botUserId });
        if (!target) return reply("No recent bball message to delete in this channel.");
        await client.chat.delete({ channel, ts: target.ts });
        return reply("🗑️ Deleted the most recent bball message.");
      }

      const editMatch = /^edit(\s+(.*))?$/i.exec(text);
      if (editMatch) {
        const editText = (editMatch[2] ?? "").trim();
        if (!editText) {
          return reply("Usage: `/ball edit <new message>` — e.g. `/ball edit tonight at 8pm instead`");
        }
        const target = await recentBotMessage({ client, channel, botUserId });
        if (!target) return reply("No recent bball message to edit in this channel.");
        const result = await client.reactions.get({ channel, timestamp: target.ts });
        const roster = categorize(result.message?.reactions ?? [], botUserId);
        const name = await resolveDisplayName({ client, userId });
        const weather = await safeWeather(fetchWeather);
        const body = formatMessage(roster, weather, { headerText: `${editText} (${name})` });
        await client.chat.update({ channel, ts: target.ts, text: body });
        return;
      }

      // Default: post a new roll-call.
      const name = await resolveDisplayName({ client, userId });
      const weather = await safeWeather(fetchWeather);
      const body = formatMessage(EMPTY_ROSTER, weather, { headerText: `${text} (${name})` });
      await client.chat.postMessage({ channel, text: body });
    } catch (err) {
      console.error("/ball action failed", err);
      return reply(`Sorry, that failed: ${err.data?.error || err.message}`);
    }
  };
}
