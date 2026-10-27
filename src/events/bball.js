// src/events/bball.js
// Basketball roll-call, folded in from ffx-bball-bot. Tuesday and Thursday
// mornings a post asks who's playing, with the Nottoway Park forecast; people
// answer by reacting, and the post is rewritten with the In / Maybe / Out
// roster after every reaction.
//
// Returns { channelIds, handles, postRollCall, handleReaction }:
//   postRollCall({ client })         — scheduled post to every bball channel
//   handleReaction({ event, client }) — reaction_added / reaction_removed
import {
  ROLLCALL_METADATA,
  ROLLCALL_PERSONA,
  formatMessage,
  isRollCallMessage,
  parseHeader,
  parseWeatherLine,
} from "../lib/bball-format.js";
import { categorize } from "../lib/bball-categorize.js";
import { resolveWeather } from "../services/bballWeather.js";
import { log, metric } from "../lib/logger.js";

const DIMENSIONS = { Flow: "bball" };
const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const REACTION_EVENTS = new Set(["reaction_added", "reaction_removed"]);

// reactions.get can trail the event: a read taken right after reaction_added
// may not list the new reaction yet, and the post would be rewritten without
// it. Re-read after each delay until the event shows.
const RESYNC_DELAYS_MS = [250, 500, 750];

// The post was deleted, or is too old to edit. Nothing to do, and retrying
// won't change that.
const TOLERATED_UPDATE_ERRORS = new Set(["cant_update_message", "message_not_found"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reflectsEvent(reactions, event) {
  if (!event.user || !event.reaction) return true;
  const entry = reactions.find((r) => r.name === event.reaction);
  const present = entry?.users?.includes(event.user) ?? false;
  return event.type === "reaction_added" ? present : !present;
}

export function createBballHandler({ channelIds = [], now = () => new Date(), sleep = defaultSleep, fetchWeatherImpl } = {}) {
  const channels = [...channelIds];
  const channelSet = new Set(channels);

  // The bot never reacts to its own roll-call today, but if it ever does its
  // reaction must not put it on the roster. Looked up once per container.
  let botUserIdPromise;
  function botUserId(client) {
    if (!botUserIdPromise) {
      botUserIdPromise = client.auth.test().then((r) => r.user_id).catch((error) => {
        botUserIdPromise = undefined;
        throw error;
      });
    }
    return botUserIdPromise;
  }

  function handles(event) {
    return REACTION_EVENTS.has(event?.type) && channelSet.has(event.item?.channel);
  }

  // If the event never shows, the last read wins: a later opposite event may
  // have already undone it.
  async function readReactions(client, channel, ts, event) {
    let reactions = [];
    for (const delay of [0, ...RESYNC_DELAYS_MS]) {
      if (delay) await sleep(delay);
      const result = await client.reactions.get({ channel, timestamp: ts, full: true });
      reactions = result.message?.reactions ?? [];
      if (reflectsEvent(reactions, event)) break;
    }
    return reactions;
  }

  async function handleReaction({ event, client }) {
    if (!handles(event)) return;
    const { channel, ts } = event.item;
    if (!ts || (event.item.type && event.item.type !== "message")) return;

    const history = await client.conversations.history({
      channel, latest: ts, inclusive: true, limit: 1, include_all_metadata: true,
    });
    const original = history.messages?.[0];
    // Not ours, or a thread reply (history returns the nearest top-level
    // message instead).
    if (!original || original.ts !== ts || !isRollCallMessage(original)) return;

    const [reactions, selfId] = await Promise.all([readReactions(client, channel, ts, event), botUserId(client)]);
    const roster = categorize(reactions, selfId);

    const originalText = original.text ?? "";
    const text = formatMessage(roster, parseWeatherLine(originalText), { headerText: parseHeader(originalText) });

    try {
      // Passing the metadata again keeps the post recognisable as a roll-call.
      await client.chat.update({ channel, ts, text, metadata: ROLLCALL_METADATA });
    } catch (error) {
      if (TOLERATED_UPDATE_ERRORS.has(error.data?.error)) {
        log.info("bball: roll-call no longer editable", { channel, ts, slackError: error.data.error });
        return;
      }
      throw error;
    }
    log.info("bball: roster updated", { channel, ts, in: roster.in.length, maybe: roster.maybe.length, out: roster.out.length });
  }

  // Posts to every channel; one channel failing doesn't stop the others. Throws
  // only when every channel failed, so the Lambda's error alarm fires.
  async function postRollCall({ client }) {
    if (channels.length === 0) {
      log.warn("bball: roll call skipped, no channels configured");
      return [];
    }
    log.info("bball: roll call starting", { channelCount: channels.length });

    const weather = await resolveWeather({ client, channels, fetchWeatherImpl, sleep, now: now() });
    const text = formatMessage(EMPTY_ROSTER, weather);

    const results = await Promise.allSettled(
      channels.map((channel) =>
        client.chat.postMessage({ channel, text, ...ROLLCALL_PERSONA, metadata: ROLLCALL_METADATA })
      )
    );

    const failures = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failures.push({ channel: channels[i], error: result.reason });
        log.error("bball: roll call post failed", { channel: channels[i], error: result.reason });
      }
    });

    const posted = results.length - failures.length;
    // RollCallPosted is what "the bot worked" means; finishing without
    // throwing doesn't imply anyone saw a roll call.
    metric("RollCallPosted", posted, { dimensions: DIMENSIONS });
    if (failures.length > 0) metric("RollCallFailed", failures.length, { dimensions: DIMENSIONS });
    log.info("bball: roll call finished", { posted, failed: failures.length });

    if (failures.length === channels.length) throw failures[0].error;

    return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  }

  return { channelIds: channelSet, handles, postRollCall, handleReaction };
}
