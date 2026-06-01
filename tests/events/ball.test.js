import { describe, it, expect, vi } from "vitest";
import { createBallHandler } from "../../src/events/ball.js";

const BOT = "UBOT";

function makeClient(over = {}) {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      history: vi.fn().mockResolvedValue({ messages: [{ ts: "9.9", user: BOT, text: "🏀 today?" }] }),
    },
    reactions: { get: vi.fn().mockResolvedValue({ message: { reactions: [] } }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: "Alice" } } }) },
    ...over,
  };
}

function envelope(text, over = {}) {
  return { type: "slash_command", command: "/ball", text, user_id: "U1", channel_id: "C1",
           response_url: "https://hooks.slack.com/x", ...over };
}

const noWeather = async () => null;

describe("createBallHandler", () => {
  it("with no text posts usage help ephemerally", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope(""), client });
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("*Usage*");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("info reports git sha and run number", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT, gitSha: "abc123", runNumber: "42" })(
      { envelope: envelope("info"), client });
    const text = client.chat.postEphemeral.mock.calls[0][0].text;
    expect(text).toContain("abc123");
    expect(text).toContain("#42");
  });

  it("schedule subcommand replies that runtime control was removed", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("schedule pause"), client });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/deploy/i);
  });

  it("plain text posts a new roll-call attributed to the caller", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("tonight 7pm"), client });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const arg = client.chat.postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.text).toBe("tonight 7pm (Alice)");
  });

  it("delete removes the most recent bot message", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("delete"), client });
    expect(client.chat.delete).toHaveBeenCalledWith({ channel: "C1", ts: "9.9" });
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/Deleted/);
  });

  it("edit rewrites the most recent bot message header", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("edit 8pm instead"), client });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(client.chat.update.mock.calls[0][0].text).toBe("8pm instead (Alice)");
  });

  it("edit with no message gives usage", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("edit"), client });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/Usage: `\/ball edit/);
  });

  it("delete with no prior message replies that none was found", async () => {
    const client = makeClient({ conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) } });
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })({ envelope: envelope("delete"), client });
    expect(client.chat.delete).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/No recent/);
  });

  it("replies when the channel cannot be determined (non-info/schedule command)", async () => {
    const client = makeClient();
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })(
      { envelope: envelope("tonight 7pm", { channel_id: undefined }), client });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/Could not determine the current channel/);
  });

  it("edit with no prior bot message replies that none was found", async () => {
    const client = makeClient({ conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) } });
    await createBallHandler({ fetchWeather: noWeather, botUserId: BOT })(
      { envelope: envelope("edit 8pm instead"), client });
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toMatch(/No recent/);
  });
});
