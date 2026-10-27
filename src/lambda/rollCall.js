// src/lambda/rollCall.js
// Tuesday and Thursday 8 AM ET: posts the basketball roll-call to every
// channel in BBALL_CHANNEL_IDS. Reactions to it are handled by the worker
// (src/events/bball.js).
//
// Builds its own Slack client instead of calling getDeps(): loadConfig()
// requires the worker's Google and Anthropic settings, which this Lambda has
// no use for and isn't given.
import { TaggedWebClient } from "../lib/slack-client.js";
import { parseBballChannelIds } from "../lib/bball-format.js";
import { createBballHandler } from "../events/bball.js";
import { log, withCorrelationId } from "../lib/logger.js";

let client;

export async function handler(_event, context) {
  return withCorrelationId(context?.awsRequestId, async () => {
    const channelIds = parseBballChannelIds(process.env.BBALL_CHANNEL_IDS);
    if (channelIds.length === 0) {
      log.warn("roll call skipped: BBALL_CHANNEL_IDS not set");
      return;
    }
    client ??= new TaggedWebClient(process.env.SLACK_BOT_TOKEN);
    await createBballHandler({ channelIds }).postRollCall({ client });
  });
}

export function _resetForTests() {
  client = undefined;
}
