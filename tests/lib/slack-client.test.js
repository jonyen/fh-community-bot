// tests/lib/slack-client.test.js
import { describe, it, expect, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { TaggedWebClient } from "../../src/lib/slack-client.js";

describe("TaggedWebClient", () => {
  it("tags a failed call with its Slack method and channel", async () => {
    const spy = vi.spyOn(WebClient.prototype, "apiCall").mockRejectedValue(new Error("An API error occurred: channel_not_found"));
    const client = new TaggedWebClient("xoxb-test");
    const error = await client.chat.postMessage({ channel: "D9", text: "hi" }).catch((e) => e);
    expect(error).toMatchObject({ slackMethod: "chat.postMessage", slackChannel: "D9" });
    spy.mockRestore();
  });
});
