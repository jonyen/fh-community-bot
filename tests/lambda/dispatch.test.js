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
      username: "FH Maintenance (beta)",
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

  it("routes a !bros message to genderHandler (top-level, no thread_ts)", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros let's go", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client,
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    const args = genderHandler.mock.calls[0][0];
    await args.say({ text: "ping" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "ping" });
  });

  it("threads the gender reply when !bros is posted in a thread", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1700.1", text: "!bros", user: "U1", ts: "1700.2" } },
      handler,
      genderHandler,
      client,
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    const args = genderHandler.mock.calls[0][0];
    await args.say({ text: "ping" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1700.1",
      text: "ping",
    });
  });

  it("does NOT route !refresh-genders typed in chat (slash command is the refresh path now)", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!refresh-genders", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros to gender path when genderHandler is undefined", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros from an app_mention event (gender is message-only)", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> !bros", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still routes non-gender thread messages to the maintenance handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes /refresh-genders slash envelope to slashRefreshHandler", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn();
    const slashRefreshHandler = vi.fn().mockResolvedValue();
    const envelope = {
      type: "slash_command",
      command: "/refresh-genders",
      user_id: "U1",
      response_url: "https://hooks.slack.com/commands/T/1/x",
    };
    await dispatchSlackEvent({
      slackEnvelope: envelope,
      handler,
      genderHandler,
      slashRefreshHandler,
      client: makeClient(),
    });
    expect(slashRefreshHandler).toHaveBeenCalledTimes(1);
    expect(slashRefreshHandler.mock.calls[0][0].envelope).toBe(envelope);
    expect(handler).not.toHaveBeenCalled();
    expect(genderHandler).not.toHaveBeenCalled();
  });

  it("ignores unknown slash commands", async () => {
    const slashRefreshHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/something-else" },
      handler: vi.fn(),
      genderHandler: vi.fn(),
      slashRefreshHandler,
      client: makeClient(),
    });
    expect(slashRefreshHandler).not.toHaveBeenCalled();
  });

  it("is a no-op for slash_command when no slashRefreshHandler provided", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/refresh-genders" },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
