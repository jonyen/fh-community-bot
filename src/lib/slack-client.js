// src/lib/slack-client.js
import { WebClient } from "@slack/web-api";

// Async stack traces lose the caller, so a failed Slack call says only
// "channel_not_found". Each error is tagged with the API method and channel.
// WebClient binds its methods to apiCall when built, so this must subclass.
export class TaggedWebClient extends WebClient {
  async apiCall(method, options) {
    try {
      return await super.apiCall(method, options);
    } catch (error) {
      error.slackMethod = method;
      error.slackChannel = options?.channel;
      throw error;
    }
  }
}
