import { describe, it, expect, vi } from "vitest";
import { dispatchSlackEvent } from "../../src/lambda/dispatch.js";

function makeClient() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
    reactions: { add: vi.fn().mockResolvedValue({}) },
    users: { info: vi.fn().mockResolvedValue({ user: { real_name: "Test" } }) },
  };
}

describe("dispatchSlackEvent", () => {
  it("invokes the handler with a say() bound to the event's channel", async () => {
    const handler = vi.fn().mockResolvedValue();
    const client = makeClient();
    const slackEvent = { type: "app_mention", channel: "C1", text: "hi", user: "U1", ts: "1" };

    await dispatchSlackEvent({
      slackEnvelope: { event: slackEvent },
      handler,
      client,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const args = handler.mock.calls[0][0];
    expect(args.event).toEqual(slackEvent);
    expect(args.client).toBe(client);
    expect(typeof args.say).toBe("function");

    await args.say({ text: "hello", thread_ts: "1" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "hello",
      thread_ts: "1",
    });
  });

  it("skips messages that are not thread replies", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips bot messages and subtyped messages", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", bot_id: "B1" } },
      handler,
      client: makeClient(),
    });
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", subtype: "message_changed" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips thread messages that contain an @mention (handled by app_mention path)", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "<@U_BOT> hi", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes thread replies (no @mention, not a bot) through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("always passes app_mention through", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
