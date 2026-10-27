import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createBballHandler } from "../../src/events/bball.js";
import { ROLLCALL_METADATA } from "../../src/lib/bball-format.js";

const BOT = "UBOT";
const WEATHER_TEXT = "🏀 today?\n\n──────────────\n☀️ Nottoway Park — 72°F, Clear sky";

function slackError(code) {
  const err = new Error(`An API error occurred: ${code}`);
  err.data = { ok: false, error: code };
  return err;
}

// A roll-call as conversations.history returns it: posted under a persona, so
// a bot_message with no `user`, recognised only by its metadata.
function rollCall(text = "🏀 today?", ts = "1.2") {
  return { type: "message", subtype: "bot_message", bot_id: "B1", username: "FFX BBall", text, ts, metadata: ROLLCALL_METADATA };
}

function makeClient({ message = rollCall(), reactions = [] } = {}) {
  return {
    auth: { test: vi.fn().mockResolvedValue({ user_id: BOT }) },
    conversations: { history: vi.fn().mockResolvedValue({ messages: message ? [message] : [] }) },
    reactions: { get: vi.fn().mockResolvedValue({ message: { reactions } }) },
    chat: { update: vi.fn().mockResolvedValue({ ok: true }), postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "9.9" }) },
  };
}

function reactionEvent(type = "reaction_added", { user = "U1", reaction = "basketball", channel = "CB", ts = "1.2" } = {}) {
  return { type, user, reaction, item: { type: "message", channel, ts } };
}

const sleep = vi.fn().mockResolvedValue();

beforeEach(() => {
  sleep.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("bball handleReaction", () => {
  const make = () => createBballHandler({ channelIds: ["CB"], sleep });

  it("rebuilds the roster and updates the post, keeping its metadata", async () => {
    const client = makeClient({
      message: rollCall(WEATHER_TEXT),
      reactions: [
        { name: "basketball", users: ["U1", "U2"] },
        { name: "x", users: ["U3"] },
      ],
    });
    await make().handleReaction({ event: reactionEvent(), client });

    expect(client.conversations.history).toHaveBeenCalledWith({ channel: "CB", latest: "1.2", inclusive: true, limit: 1, include_all_metadata: true });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const args = client.chat.update.mock.calls[0][0];
    expect(args.channel).toBe("CB");
    expect(args.ts).toBe("1.2");
    expect(args.metadata).toEqual(ROLLCALL_METADATA);
    expect(args.text).toContain("In (2): <@U1>, <@U2>");
    expect(args.text).toContain("Out: <@U3>");
    expect(args.text).toContain("☀️ Nottoway Park — 72°F, Clear sky");
  });

  it("ignores a message without the roll-call metadata, even another bot's lookalike", async () => {
    const { metadata, ...lookalike } = rollCall();
    void metadata;
    const client = makeClient({ message: lookalike });
    await make().handleReaction({ event: reactionEvent(), client });
    expect(client.reactions.get).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("ignores a reaction on a thread reply (history returns a different ts)", async () => {
    const client = makeClient({ message: rollCall("🏀 today?", "1.0") });
    await make().handleReaction({ event: reactionEvent("reaction_added", { ts: "1.5" }), client });
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("ignores reactions outside the bball channels", async () => {
    const client = makeClient();
    await make().handleReaction({ event: reactionEvent("reaction_added", { channel: "COTHER" }), client });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("treats reaction_removed the same way", async () => {
    const client = makeClient({ reactions: [] });
    await make().handleReaction({ event: reactionEvent("reaction_removed"), client });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(client.chat.update.mock.calls[0][0].text).toBe("🏀 today?");
  });

  it("preserves a custom header when rebuilding", async () => {
    const client = makeClient({
      message: rollCall("🏀 tonight at 7pm? — <@U123>\n\n──────────────\n☀️ Nottoway Park — 72°F, Clear sky"),
      reactions: [{ name: "basketball", users: ["U1"] }],
    });
    await make().handleReaction({ event: reactionEvent(), client });
    const text = client.chat.update.mock.calls[0][0].text;
    expect(text).toContain("🏀 tonight at 7pm? — <@U123>");
    expect(text).toContain("In (1): <@U1>");
    expect(text).not.toContain("🏀 today?");
  });

  it("skips the bot's own reactions, using auth.test once per handler", async () => {
    const client = makeClient({ reactions: [{ name: "basketball", users: [BOT, "U1"] }] });
    const handler = make();
    await handler.handleReaction({ event: reactionEvent(), client });
    await handler.handleReaction({ event: reactionEvent(), client });
    const text = client.chat.update.mock.calls[0][0].text;
    expect(text).toContain("In (1): <@U1>");
    expect(text).not.toContain(`<@${BOT}>`);
    expect(client.auth.test).toHaveBeenCalledTimes(1);
  });

  it.each(["cant_update_message", "message_not_found"])("tolerates %s on update", async (code) => {
    const client = makeClient();
    client.chat.update.mockRejectedValue(slackError(code));
    await expect(make().handleReaction({ event: reactionEvent(), client })).resolves.toBeUndefined();
  });

  it("rethrows other update errors so SQS retries", async () => {
    const client = makeClient();
    client.chat.update.mockRejectedValue(slackError("ratelimited"));
    await expect(make().handleReaction({ event: reactionEvent(), client })).rejects.toThrow("ratelimited");
  });

  it("rethrows a history failure", async () => {
    const client = makeClient();
    client.conversations.history.mockRejectedValue(new Error("slack hiccup"));
    await expect(make().handleReaction({ event: reactionEvent(), client })).rejects.toThrow("slack hiccup");
  });

  describe("stale reactions.get reads", () => {
    it("re-reads until an added reaction shows up", async () => {
      const client = makeClient();
      client.reactions.get
        .mockResolvedValueOnce({ message: { reactions: [{ name: "basketball", users: ["U1"] }] } })
        .mockResolvedValueOnce({ message: { reactions: [{ name: "basketball", users: ["U1", "U5"] }] } });
      await make().handleReaction({ event: reactionEvent("reaction_added", { user: "U5" }), client });
      expect(client.reactions.get).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(250);
      expect(client.chat.update.mock.calls[0][0].text).toContain("In (2): <@U1>, <@U5>");
    });

    it("re-reads until a removed reaction is gone", async () => {
      const client = makeClient();
      client.reactions.get
        .mockResolvedValueOnce({ message: { reactions: [{ name: "basketball", users: ["U1", "U5"] }] } })
        .mockResolvedValueOnce({ message: { reactions: [{ name: "basketball", users: ["U1"] }] } });
      await make().handleReaction({ event: reactionEvent("reaction_removed", { user: "U5" }), client });
      expect(client.reactions.get).toHaveBeenCalledTimes(2);
      expect(client.chat.update.mock.calls[0][0].text).not.toContain("<@U5>");
    });

    it("reads once when the first read already reflects the event", async () => {
      const client = makeClient({ reactions: [{ name: "basketball", users: ["U5"] }] });
      await make().handleReaction({ event: reactionEvent("reaction_added", { user: "U5" }), client });
      expect(client.reactions.get).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("gives up after the retries and writes the last read", async () => {
      const client = makeClient({ reactions: [{ name: "basketball", users: ["U1"] }] });
      await make().handleReaction({ event: reactionEvent("reaction_added", { user: "U5" }), client });
      expect(client.reactions.get).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 500, 750]);
      expect(client.chat.update.mock.calls[0][0].text).toContain("In (1): <@U1>");
    });
  });
});

describe("bball postRollCall", () => {
  const LIVE = { icon: "☀️", tempF: 72, description: "Clear sky" };
  const make = (channelIds, fetchWeatherImpl = async () => LIVE) => createBballHandler({ channelIds, sleep, fetchWeatherImpl });

  it("posts under the persona with the roll-call metadata and the forecast", async () => {
    const client = makeClient();
    await make(["C1"]).postRollCall({ client });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: WEATHER_TEXT,
      username: "FFX BBall",
      icon_emoji: ":basketball:",
      metadata: ROLLCALL_METADATA,
    });
  });

  it("fans out to every channel with the same text", async () => {
    const client = makeClient();
    await make(["C1", "C2"]).postRollCall({ client });
    expect(client.chat.postMessage.mock.calls.map((c) => c[0].channel)).toEqual(["C1", "C2"]);
  });

  it("posts without weather when the forecast and the cache both fail", async () => {
    const client = makeClient({ message: null });
    await make(["C1"], async () => null).postRollCall({ client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toBe("🏀 today?");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("falls back to the cached line from a prior roll-call", async () => {
    const client = makeClient({ message: rollCall("🏀 today?\n\n──────────────\n☀️ Nottoway Park — 70°F, Sunny") });
    await make(["C1"], async () => null).postRollCall({ client });
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("☀️ Nottoway Park — 70°F, Sunny (cached)");
  });

  it("emits RollCallPosted and RollCallFailed, and doesn't throw on a partial failure", async () => {
    const logSpy = console.log;
    const client = makeClient();
    client.chat.postMessage.mockRejectedValueOnce(slackError("not_in_channel")).mockResolvedValueOnce({ ok: true });
    await expect(make(["C1", "C2"]).postRollCall({ client })).resolves.toHaveLength(1);
    const lines = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
    expect(lines.find((l) => "RollCallPosted" in l)).toMatchObject({ RollCallPosted: 1, Flow: "bball" });
    expect(lines.find((l) => "RollCallFailed" in l)).toMatchObject({ RollCallFailed: 1, Flow: "bball" });
  });

  it("throws when every channel failed", async () => {
    const client = makeClient();
    client.chat.postMessage.mockRejectedValue(slackError("not_in_channel"));
    await expect(make(["C1", "C2"]).postRollCall({ client })).rejects.toThrow("not_in_channel");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("posts nothing when no channels are configured", async () => {
    const client = makeClient();
    await expect(make([]).postRollCall({ client })).resolves.toEqual([]);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
