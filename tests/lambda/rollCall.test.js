import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const postMessage = vi.fn();
const history = vi.fn();
const ctor = vi.fn();
vi.mock("../../src/lib/slack-client.js", () => ({
  TaggedWebClient: vi.fn().mockImplementation(function (token) {
    ctor(token);
    this.chat = { postMessage };
    this.conversations = { history };
  }),
}));
// Never reach NWS from a unit test.
vi.mock("../../src/services/bballWeather.js", () => ({
  resolveWeather: vi.fn().mockResolvedValue({ icon: "☀️", tempF: 72, description: "Clear sky" }),
}));

const { handler, _resetForTests } = await import("../../src/lambda/rollCall.js");

describe("rollCall Lambda", () => {
  beforeEach(() => {
    _resetForTests();
    postMessage.mockReset().mockResolvedValue({ ok: true });
    ctor.mockClear();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.BBALL_CHANNEL_IDS;
    vi.restoreAllMocks();
  });

  it("does nothing when BBALL_CHANNEL_IDS is empty", async () => {
    process.env.BBALL_CHANNEL_IDS = "";
    await expect(handler({}, { awsRequestId: "r1" })).resolves.toBeUndefined();
    expect(ctor).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts to every configured channel with the bot token, without needing loadConfig's env", async () => {
    process.env.BBALL_CHANNEL_IDS = "C1, C2";
    await handler({}, { awsRequestId: "r1" });
    expect(ctor).toHaveBeenCalledWith("xoxb-test");
    expect(postMessage.mock.calls.map((c) => c[0].channel)).toEqual(["C1", "C2"]);
  });

  it("does not throw when only some channels fail", async () => {
    process.env.BBALL_CHANNEL_IDS = "C1,C2";
    postMessage.mockRejectedValueOnce(new Error("not_in_channel"));
    await expect(handler({}, {})).resolves.toBeUndefined();
  });

  it("throws when every channel fails, so the Errors alarm fires", async () => {
    process.env.BBALL_CHANNEL_IDS = "C1,C2";
    postMessage.mockRejectedValue(new Error("invalid_auth"));
    await expect(handler({}, {})).rejects.toThrow("invalid_auth");
  });
});
