import { describe, it, expect, vi } from "vitest";
import { createPostMessageRunner } from "../../src/events/post.js";

function makeClient(postImpl) {
  return {
    chat: { postMessage: vi.fn().mockImplementation(postImpl ?? (async () => ({ ok: true }))) },
    conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
  };
}

describe("createPostMessageRunner", () => {
  it("posts the roll-call to every channel with live weather", async () => {
    const client = makeClient();
    const fetchWeather = vi.fn().mockResolvedValue({ icon: "☀️", tempF: 70, description: "Clear" });
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1", "C2"], botUserId: "UBOT", retryDelayMs: 0 });
    await run();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const text = client.chat.postMessage.mock.calls[0][0].text;
    expect(text).toContain("🏀 today?");
    expect(text).toContain("70°F");
  });

  it("retries weather up to 3 times then falls back to cached line", async () => {
    const fetchWeather = vi.fn().mockResolvedValue(null);
    const client = makeClient();
    client.conversations.history.mockResolvedValue({
      messages: [{ user: "UBOT", text: "🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 60°F, Clear" }],
    });
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1"], botUserId: "UBOT", retryDelayMs: 0 });
    await run();
    expect(fetchWeather).toHaveBeenCalledTimes(3);
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain("(cached)");
  });

  it("throws when every channel post fails", async () => {
    const client = makeClient(async () => { throw new Error("slack down"); });
    const fetchWeather = vi.fn().mockResolvedValue(null);
    const run = createPostMessageRunner({ client, fetchWeather, channels: ["C1"], botUserId: "UBOT", retryDelayMs: 0 });
    await expect(run()).rejects.toThrow("slack down");
  });
});
