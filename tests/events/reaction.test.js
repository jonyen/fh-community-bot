import { describe, it, expect, vi } from "vitest";
import { createReactionHandler } from "../../src/events/reaction.js";

const BOT = "UBOT";
const ORIGINAL = "🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky";

function makeClient({ original = { ts: "100.1", user: BOT, text: ORIGINAL }, reactions = [], updateError = null } = {}) {
  return {
    conversations: { history: vi.fn().mockResolvedValue({ messages: original ? [original] : [] }) },
    reactions: { get: vi.fn().mockResolvedValue({ message: { reactions } }) },
    chat: {
      update: vi.fn().mockImplementation(async () => {
        if (updateError) throw updateError;
        return { ok: true };
      }),
    },
  };
}

const evt = (type = "reaction_added") => ({ type, item: { channel: "C1", ts: "100.1" } });

describe("createReactionHandler", () => {
  it("ignores non-reaction events", async () => {
    const client = makeClient();
    await createReactionHandler({ botUserId: BOT })({ event: { type: "message" }, client });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("ignores reactions on messages not authored by the bot", async () => {
    const client = makeClient({ original: { ts: "100.1", user: "USOMEONE", text: ORIGINAL } });
    await createReactionHandler({ botUserId: BOT })({ event: evt(), client });
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("recategorizes reactions and updates the roster, preserving header + weather", async () => {
    const client = makeClient({ reactions: [{ name: "basketball", users: ["U1", BOT] }] });
    await createReactionHandler({ botUserId: BOT })({ event: evt(), client });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.ts).toBe("100.1");
    expect(arg.text).toBe("🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky");
  });

  it("swallows cant_update_message / message_not_found", async () => {
    const client = makeClient({
      reactions: [{ name: "x", users: ["U1"] }],
      updateError: Object.assign(new Error("e"), { data: { error: "message_not_found" } }),
    });
    await expect(createReactionHandler({ botUserId: BOT })({ event: evt(), client })).resolves.toBeUndefined();
  });
});
